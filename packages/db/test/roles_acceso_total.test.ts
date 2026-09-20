/**
 * Roles CEO y Administradora (migración 0048).
 *
 * Lo que importa comprobar aquí no es que existan, sino que tengan acceso COMPLETO de verdad —en la
 * base, que es donde se decide— y que sigan siendo dos roles distintos: el día que uno deba perder
 * un permiso, debe poder perderlo sin arrastrar al otro.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll, sql } from "./helpers.ts";

const { db, pool } = testDb();

const permisosDe = (rol: string) =>
  sql<{ key: string }>`select permission_key as key from role_permissions
                        where role_key = ${rol} order by permission_key`
    .execute(db)
    .then((r) => r.rows.map((x) => x.key));

const todos = () =>
  sql<{ key: string }>`select key from permissions order by key`
    .execute(db)
    .then((r) => r.rows.map((x) => x.key));

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("roles de acceso total", () => {
  it("CEO y Administradora existen, están en el sistema y tienen su nombre en español", async () => {
    const r = await sql<{ key: string; name: string; rank: number; is_system: boolean }>`
      select key, name, rank, is_system from roles where key in ('ceo','admin') order by rank desc`.execute(
      db,
    );
    expect(r.rows).toEqual([
      { key: "ceo", name: "CEO", rank: 95, is_system: true },
      { key: "admin", name: "Administradora", rank: 85, is_system: true },
    ]);
  });

  it("ambos tienen TODOS los permisos que existen", async () => {
    const esperado = await todos();
    expect(esperado.length).toBeGreaterThan(0);
    expect(await permisosDe("ceo")).toEqual(esperado);
    expect(await permisosDe("admin")).toEqual(esperado);
    // Incluidos los delicados, que son los que suelen quedarse fuera por descuido.
    for (const p of ["staff.write", "settings.write", "audit.read", "pos.refund", "reports.export"])
      expect(await permisosDe("ceo"), p).toContain(p);
  });

  it("son dos roles separados: quitarle un permiso a uno no toca al otro", async () => {
    // Los permisos de los roles son datos de configuración: `truncateAll` no los repone, así que
    // esta prueba deshace lo suyo para no dejar al rol mutilado en las siguientes.
    try {
      await sql`delete from role_permissions where role_key = 'admin' and permission_key = 'staff.write'`.execute(
        db,
      );
      expect(await permisosDe("admin")).not.toContain("staff.write");
      expect(await permisosDe("ceo")).toContain("staff.write");
    } finally {
      await sql`insert into role_permissions(role_key, permission_key) values ('admin','staff.write')
                on conflict do nothing`.execute(db);
    }
  });

  it("no se tocaron los roles que ya existían", async () => {
    const r = await sql<{ key: string; n: number }>`
      select r.key, count(rp.permission_key)::int as n
        from roles r left join role_permissions rp on rp.role_key = r.key
       where r.key in ('super_admin','owner','manager','cashier','production','sales','marketing')
       group by r.key order by r.key`.execute(db);
    const n = Object.fromEntries(r.rows.map((x) => [x.key, x.n]));
    const total = (await todos()).length;
    expect(n.super_admin).toBe(total);
    expect(n.owner).toBe(total);
    expect(n.manager).toBe(total - 1); // manager sigue sin staff.write
    expect(n.cashier).toBe(9);
    expect(n.production).toBe(7);
  });

  it("un usuario con rol CEO o admin resuelve sus permisos por el camino normal", async () => {
    for (const rol of ["ceo", "admin"]) {
      const u = await sql<{ id: string }>`
        insert into staff_users(email, full_name, password_hash, role_key)
        values (${`${rol}@prueba.local`}, ${`Prueba ${rol}`}, 'x', ${rol}) returning id`.execute(
        db,
      );
      const permisos = await sql<{ n: number }>`
        select count(*)::int as n from role_permissions rp
         join staff_users u on u.role_key = rp.role_key
        where u.id = ${u.rows[0]!.id}`.execute(db);
      expect(permisos.rows[0]!.n, rol).toBe((await todos()).length);
    }
  });
});
