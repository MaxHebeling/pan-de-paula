/**
 * Auditoría auth/seguridad a nivel SQL: matriz de permisos por rol, trigger de auditoría sin secretos,
 * identidad del actor (app.staff_id) solo dentro de transacción, y privilegios del rol de aplicación.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff, sql, testDb, truncateAll, withStaff } from "./helpers.ts";

const { db } = testDb();

beforeAll(async () => {
  await truncateAll(db);
});
afterAll(async () => {
  await db.destroy();
});

async function perms(role: string): Promise<Set<string>> {
  const r = await sql<{
    permission_key: string;
  }>`select permission_key from role_permissions where role_key = ${role}`.execute(db);
  return new Set(r.rows.map((x) => x.permission_key));
}

describe("matriz de permisos por rol (seed 0001)", () => {
  it("cashier no administra usuarios, configuración, auditoría ni reembolsa; production no vende; marketing no ve caja", async () => {
    const cashier = await perms("cashier");
    for (const p of ["staff.write", "settings.write", "audit.read", "pos.refund", "recipes.write"])
      expect(cashier.has(p), `cashier NO debe tener ${p}`).toBe(false);
    for (const p of ["pos.sell", "pos.register", "orders.write", "customers.read"])
      expect(cashier.has(p), `cashier debe tener ${p}`).toBe(true);

    const production = await perms("production");
    for (const p of ["pos.sell", "pos.register", "pos.refund", "customers.read", "staff.write"])
      expect(production.has(p), `production NO debe tener ${p}`).toBe(false);
    expect(production.has("production.write")).toBe(true);

    const marketing = await perms("marketing");
    for (const p of ["pos.sell", "pos.register", "pos.refund", "orders.write", "inventory.read"])
      expect(marketing.has(p), `marketing NO debe tener ${p}`).toBe(false);
    expect(marketing.has("marketing.write")).toBe(true);

    const sales = await perms("sales");
    for (const p of ["pos.register", "pos.refund", "staff.write", "settings.write"])
      expect(sales.has(p), `sales NO debe tener ${p}`).toBe(false);
  });

  it("manager tiene todo menos staff.write; owner y super_admin tienen todo", async () => {
    const all = await sql<{ key: string }>`select key from permissions`.execute(db);
    const manager = await perms("manager");
    expect(manager.has("staff.write")).toBe(false);
    expect(manager.size).toBe(all.rows.length - 1);
    expect((await perms("owner")).size).toBe(all.rows.length);
    expect((await perms("super_admin")).size).toBe(all.rows.length);
  });

  it("los rangos ordenan la jerarquía: super_admin > owner > manager > operativos (empatados)", async () => {
    const r = await sql<{
      key: string;
      rank: number;
    }>`select key, rank from roles order by rank desc, key`.execute(db);
    const rank = Object.fromEntries(r.rows.map((x) => [x.key, x.rank]));
    expect(rank.super_admin).toBeGreaterThan(rank.owner!);
    expect(rank.owner).toBeGreaterThan(rank.manager!);
    for (const k of ["cashier", "production", "sales", "marketing"])
      expect(rank.manager).toBeGreaterThan(rank[k]!);
  });
});

describe("auditoría de staff_users", () => {
  it("INSERT/UPDATE/DELETE quedan en audit_logs sin password_hash ni pin_hash y con el staff_id del actor", async () => {
    const actor = await createStaff(db, "actor@pdp.local", "owner");
    let targetId = "";
    await withStaff(db, actor, async (trx) => {
      const r = await sql<{
        id: string;
      }>`insert into staff_users(email, full_name, password_hash, pin_hash, role_key) values ('nuevo@pdp.local', 'Nuevo', '$argon2id$secreto', '$argon2id$pin', 'cashier') returning id`.execute(
        trx,
      );
      targetId = r.rows[0]!.id;
      await sql`update staff_users set role_key = 'sales', is_active = false where id = ${targetId}`.execute(
        trx,
      );
      await sql`delete from staff_users where id = ${targetId}`.execute(trx);
    });
    const logs = await sql<{
      action: string;
      staff_id: string | null;
      old_data: Record<string, unknown> | null;
      new_data: Record<string, unknown> | null;
    }>`select action, staff_id, old_data, new_data from audit_logs where entity = 'staff_users' and entity_id = ${targetId} order by id`.execute(
      db,
    );
    expect(logs.rows.map((l) => l.action)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    for (const l of logs.rows) {
      expect(l.staff_id).toBe(actor);
      const text = JSON.stringify([l.old_data, l.new_data]);
      expect(text).not.toContain("password_hash");
      expect(text).not.toContain("pin_hash");
      expect(text).not.toContain("argon2");
    }
    expect(logs.rows[1]!.old_data?.role_key).toBe("cashier");
    expect(logs.rows[1]!.new_data?.role_key).toBe("sales");
    expect(logs.rows[1]!.new_data?.is_active).toBe(false);
  });

  it("un UPDATE que solo toca password_hash no deja diff con datos (y no revela el hash)", async () => {
    const id = await createStaff(db, "solo-hash@pdp.local", "cashier");
    await withStaff(db, id, (trx) =>
      sql`update staff_users set password_hash = '$argon2id$otro' where id = ${id}`.execute(trx),
    );
    const logs = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_logs where entity = 'staff_users' and entity_id = ${id} and action = 'UPDATE'`.execute(
      db,
    );
    // El trigger ignora cambios que solo tocan campos ocultos/updated_at
    expect(logs.rows[0]?.n).toBe(0);
  });

  it("los contadores de login (failed_logins/locked_until/last_login_at) no generan filas UPDATE 'sistema' (0012)", async () => {
    const id = await createStaff(db, "contador@pdp.local", "cashier");
    await sql`update staff_users set failed_logins = 3, locked_until = now() + interval '15 minutes' where id = ${id}`.execute(
      db,
    );
    await sql`update staff_users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${id}`.execute(
      db,
    );
    const noise = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_logs where entity = 'staff_users' and entity_id = ${id} and action = 'UPDATE'`.execute(
      db,
    );
    expect(noise.rows[0]?.n).toBe(0);
    // Un cambio real sí se audita, y el diff no arrastra los contadores
    await withStaff(db, id, (trx) =>
      sql`update staff_users set full_name = 'Contador Renombrado', failed_logins = 9 where id = ${id}`.execute(
        trx,
      ),
    );
    const real = await sql<{
      new_data: Record<string, unknown>;
    }>`select new_data from audit_logs where entity = 'staff_users' and entity_id = ${id} and action = 'UPDATE'`.execute(
      db,
    );
    expect(real.rows).toHaveLength(1);
    expect(real.rows[0]!.new_data.full_name).toBe("Contador Renombrado");
    expect(real.rows[0]!.new_data).not.toHaveProperty("failed_logins");
    expect(real.rows[0]!.new_data).not.toHaveProperty("last_login_at");
  });

  it("set_config('app.staff_id') fuera de transacción NO persiste: la siguiente sentencia no tiene actor", async () => {
    const actor = await createStaff(db, "fuera@pdp.local", "owner");
    // is_local = true fuera de una transacción explícita: vive solo en esa sentencia (autocommit).
    await sql`select set_config('app.staff_id', ${actor}, true)`.execute(db);
    const r = await sql<{ id: string | null }>`select current_staff_id() as id`.execute(db);
    expect(r.rows[0]?.id).toBeNull();
    // Dentro de withStaff sí se ve
    const inside = await withStaff(db, actor, async (trx) => {
      const x = await sql<{ id: string | null }>`select current_staff_id() as id`.execute(trx);
      return x.rows[0]?.id ?? null;
    });
    expect(inside).toBe(actor);
    // Y al salir de la transacción, la conexión no arrastra la identidad
    const after = await sql<{ id: string | null }>`select current_staff_id() as id`.execute(db);
    expect(after.rows[0]?.id).toBeNull();
  });

  it("current_staff_id() con un valor que no es UUID no revienta el trigger de auditoría en transacción", async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('app.staff_id', '', true)`.execute(trx);
        const x = await sql<{ id: string | null }>`select current_staff_id() as id`.execute(trx);
        return x.rows[0]?.id ?? null;
      }),
    ).resolves.toBeNull();
  });
});

describe("auditoría de configuración (0012)", () => {
  it("horarios y puntos de retiro quedan en audit_logs con el actor y un entity_id útil", async () => {
    const actor = await createStaff(db, "config@pdp.local", "manager");
    let pickupId = "";
    await withStaff(db, actor, async (trx) => {
      await sql`update business_hours set opens_at = '07:30' where weekday = 2`.execute(trx);
      const r = await sql<{
        id: string;
      }>`insert into pickup_points(name, map_url) values ('Retiro auditoría', 'https://maps.example/1') returning id`.execute(
        trx,
      );
      pickupId = r.rows[0]!.id;
      await sql`update pickup_points set is_active = false where id = ${pickupId}`.execute(trx);
      await sql`update feature_flags set enabled = not enabled where key = 'email_receipts'`.execute(
        trx,
      );
    });
    const rows = await sql<{
      entity: string;
      action: string;
      entity_id: string | null;
      staff_id: string | null;
    }>`select entity, action, entity_id, staff_id from audit_logs where staff_id = ${actor} order by id`.execute(
      db,
    );
    expect(rows.rows.map((r) => `${r.entity}:${r.action}:${r.entity_id}`)).toEqual([
      "business_hours:UPDATE:2",
      `pickup_points:INSERT:${pickupId}`,
      `pickup_points:UPDATE:${pickupId}`,
      "feature_flags:UPDATE:email_receipts",
    ]);
    // Guardar horarios sin cambios reales no genera ruido
    await withStaff(db, actor, (trx) =>
      sql`update business_hours set opens_at = opens_at where weekday = 2`.execute(trx),
    );
    const again = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_logs where staff_id = ${actor} and entity = 'business_hours'`.execute(
      db,
    );
    expect(again.rows[0]?.n).toBe(1);
  });
});

describe("integridad de sesiones y tokens", () => {
  it("token_hash de sesión y de reset son únicos; borrar el usuario cascada sesiones y tokens", async () => {
    const id = await createStaff(db, "cascade@pdp.local", "cashier");
    await sql`insert into staff_sessions(staff_id, token_hash, expires_at) values (${id}, 'h1', now() + interval '1 day')`.execute(
      db,
    );
    await expect(
      sql`insert into staff_sessions(staff_id, token_hash, expires_at) values (${id}, 'h1', now() + interval '1 day')`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await sql`insert into password_reset_tokens(staff_id, token_hash, expires_at) values (${id}, 'r1', now() + interval '1 hour')`.execute(
      db,
    );
    await expect(
      sql`insert into password_reset_tokens(staff_id, token_hash, expires_at) values (${id}, 'r1', now() + interval '1 hour')`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await sql`delete from staff_users where id = ${id}`.execute(db);
    const left = await sql<{
      n: number;
    }>`select (select count(*) from staff_sessions where staff_id = ${id})::int + (select count(*) from password_reset_tokens where staff_id = ${id})::int as n`.execute(
      db,
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it("login_attempts acepta ip nula (cliente sin IP válida) y el email se compara sin distinguir mayúsculas (citext)", async () => {
    await sql`insert into login_attempts(email, ip, success) values ('Mixto@PDP.local', null, false)`.execute(
      db,
    );
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from login_attempts where email = 'mixto@pdp.local'`.execute(db);
    expect(r.rows[0]?.n).toBe(1);
    const u = await sql<{
      n: number;
    }>`select count(*)::int as n from staff_users where email = 'ACTOR@pdp.local'`.execute(db);
    expect(u.rows[0]?.n).toBe(1);
  });
});

describe("rol de aplicación (0009_security)", () => {
  it("anon/authenticated no pueden leer tablas de staff; pdp_app sí (RLS con política total)", async () => {
    const check = async (role: string, table: string) => {
      const r = await sql<{
        ok: boolean;
      }>`select has_table_privilege(${role}, ${table}, 'select') as ok`.execute(db);
      return r.rows[0]?.ok ?? null;
    };
    for (const t of ["staff_users", "staff_sessions", "password_reset_tokens", "audit_logs"]) {
      expect(await check("anon", t), `anon select ${t}`).toBe(false);
      expect(await check("authenticated", t), `authenticated select ${t}`).toBe(false);
      expect(await check("pdp_app", t), `pdp_app select ${t}`).toBe(true);
    }
    const rls = await sql<{
      relname: string;
      relrowsecurity: boolean;
    }>`select relname, relrowsecurity from pg_class where relname in ('staff_users','staff_sessions','password_reset_tokens','audit_logs')`.execute(
      db,
    );
    for (const r of rls.rows) expect(r.relrowsecurity, `RLS en ${r.relname}`).toBe(true);
  });
});
