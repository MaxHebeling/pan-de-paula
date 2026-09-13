/**
 * Auditoría de autenticación (audit/auth): regresiones de los bugs corregidos y garantías de seguridad.
 * Usa la misma base `<DATABASE_URL_TEST>_auth` que auth.test.ts (vitest corre los archivos en serie).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sql } from "@pdp/db";
import {
  changePassword,
  clientIpFromHeaders,
  consumePasswordReset,
  createPasswordReset,
  hashPassword,
  login,
  normalizeIp,
  resolveSession,
  revokeAllSessions,
  verifyPassword,
} from "../src/index.ts";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });
const base = new URL(process.env.DATABASE_URL_TEST!);
base.pathname = base.pathname.replace(/\/?$/, "") + "_auth";
const url = base.toString();
const { db } = createDb({ connectionString: url, ssl: false, max: 4 });

const PW = "ClaveSegura123";
const users = {
  ana: "ana@audit.local",
  beto: "beto@audit.local",
  cami: "cami@audit.local",
  dani: "dani@audit.local",
  inactiva: "inactiva@audit.local",
};

async function reset(email: string) {
  await sql`update staff_users set failed_logins = 0, locked_until = null, is_active = true where email = ${email}`.execute(
    db,
  );
}

async function staffRow(email: string) {
  const r = await sql<{
    id: string;
    failed_logins: number;
    locked_until: Date | null;
    must_change_password: boolean;
  }>`select id, failed_logins, locked_until, must_change_password from staff_users where email = ${email}`.execute(
    db,
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  const admin = new URL(url);
  const dbName = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  const exists = await c.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) await c.query(`create database "${dbName}"`);
  await c.end();
  const { migrate } = await import("../../db/scripts/migrate.ts");
  await migrate(url, { log: () => {} });
  await sql`truncate staff_sessions, login_attempts, password_reset_tokens, audit_logs, staff_users restart identity cascade`.execute(
    db,
  );
  const ph = await hashPassword(PW);
  for (const [name, email] of Object.entries(users)) {
    await sql`insert into staff_users(email, full_name, password_hash, role_key, is_active) values (${email}, ${name}, ${ph}, 'cashier', ${email !== users.inactiva})`.execute(
      db,
    );
  }
});
afterAll(async () => {
  await db.destroy();
});

describe("IP del cliente", () => {
  it("normalizeIp acepta IPs válidas (con puerto/corchetes) y rechaza basura", () => {
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp(" 1.2.3.4:5678 ")).toBe("1.2.3.4");
    expect(normalizeIp("[::1]:443")).toBe("::1");
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("::ffff:10.0.0.1");
    expect(normalizeIp("garbage")).toBeNull();
    expect(normalizeIp("1.2.3.4, 5.6.7.8")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp("1.2.3.4'; drop table staff_users; --")).toBeNull();
  });

  it("clientIpFromHeaders toma el primer salto válido de x-forwarded-for y cae a x-real-ip", () => {
    const h = (map: Record<string, string>) => (n: string) => map[n] ?? null;
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "unknown, 5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "garbage", "x-real-ip": "9.9.9.9" }))).toBe(
      "9.9.9.9",
    );
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });

  it("login no revienta con una IP inválida: la descarta y sigue (BUG: 500 en /login con X-Forwarded-For basura)", async () => {
    const r = await login(db, { email: users.ana, password: PW, ip: "garbage" });
    expect(r.ok).toBe(true);
    const r2 = await login(db, { email: users.ana, password: PW, ip: "1.2.3.4, 5.6.7.8" });
    expect(r2.ok).toBe(true);
    const s = await sql<{
      ip: string | null;
    }>`select ip::text as ip from staff_sessions where staff_id = (select id from staff_users where email = ${users.ana}) order by created_at desc limit 1`.execute(
      db,
    );
    expect(s.rows[0]?.ip).toBeNull();
  });

  it("user-agent gigante se recorta a 512 caracteres", async () => {
    const r = await login(db, { email: users.ana, password: PW, userAgent: "U".repeat(5000) });
    expect(r.ok).toBe(true);
    const s = await sql<{
      len: number;
    }>`select length(user_agent)::int as len from staff_sessions where staff_id = (select id from staff_users where email = ${users.ana}) order by created_at desc limit 1`.execute(
      db,
    );
    expect(s.rows[0]?.len).toBe(512);
  });
});

describe("bloqueo por intentos", () => {
  it("tras vencer el bloqueo, el contador arranca de cero (BUG: un solo fallo re-bloqueaba 15 min)", async () => {
    await reset(users.beto);
    for (let i = 0; i < 5; i++) {
      const r = await login(db, { email: users.beto, password: "mala-clave-1" });
      expect(r.ok).toBe(false);
    }
    expect((await staffRow(users.beto)).locked_until).not.toBeNull();
    // Simula que pasaron los 15 minutos
    await sql`update staff_users set locked_until = now() - interval '1 second' where email = ${users.beto}`.execute(
      db,
    );
    const r = await login(db, { email: users.beto, password: "mala-clave-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_credentials");
    const row = await staffRow(users.beto);
    expect(row.failed_logins).toBe(1);
    expect(row.locked_until).toBeNull();
    // Y con la clave correcta entra y limpia el contador
    const ok = await login(db, { email: users.beto, password: PW });
    expect(ok.ok).toBe(true);
    expect((await staffRow(users.beto)).failed_logins).toBe(0);
  });

  it("mientras dura el bloqueo, ni la clave correcta entra", async () => {
    await reset(users.beto);
    for (let i = 0; i < 5; i++) await login(db, { email: users.beto, password: "mala-clave-1" });
    const r = await login(db, { email: users.beto, password: PW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("locked");
    await reset(users.beto);
  });

  it("rate limit por IP: 30 fallos en 15 min bloquean la IP aunque cambie el correo", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 30; i++) {
      await sql`insert into login_attempts(email, ip, success) values (${"x" + i + "@nadie.local"}, ${ip}::inet, false)`.execute(
        db,
      );
    }
    const r = await login(db, { email: users.ana, password: PW, ip });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("rate_limited");
    await sql`delete from login_attempts where ip = ${ip}::inet`.execute(db);
  });
});

describe("anti-enumeración de cuentas", () => {
  it("cuenta desactivada + clave incorrecta responde igual que credenciales inválidas", async () => {
    const r = await login(db, { email: users.inactiva, password: "otra-clave-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_credentials");
  });

  it("cuenta desactivada + clave correcta informa 'inactive' (solo a quien conoce la clave) y no crea sesión", async () => {
    const r = await login(db, { email: users.inactiva, password: PW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("inactive");
    const s = await sql<{
      n: number;
    }>`select count(*)::int as n from staff_sessions where staff_id = (select id from staff_users where email = ${users.inactiva})`.execute(
      db,
    );
    expect(s.rows[0]?.n).toBe(0);
  });

  it("un correo inexistente también 'se bloquea' al 5º fallo: no se distingue de una cuenta real", async () => {
    const email = "fantasma@audit.local";
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await login(db, { email, password: "mala-clave-1" });
      if (!r.ok) reasons.push(r.reason);
    }
    expect(reasons.slice(0, 4)).toEqual(Array(4).fill("invalid_credentials"));
    expect(reasons[4]).toBe("locked");
    expect(reasons[5]).toBe("locked");
  });

  it("el correo se normaliza (mayúsculas/espacios) y la contraseña NO (un espacio extra la invalida)", async () => {
    const ok = await login(db, { email: "  ANA@Audit.LOCAL ", password: PW });
    expect(ok.ok).toBe(true);
    const bad = await login(db, { email: users.ana, password: PW + " " });
    expect(bad.ok).toBe(false);
    await reset(users.ana);
  });
});

describe("restablecimiento de contraseña", () => {
  it("dos consumos simultáneos del mismo token: exactamente uno gana (BUG: los dos cambiaban la clave)", async () => {
    const pr = await createPasswordReset(db, users.cami);
    expect(pr).not.toBeNull();
    const results = await Promise.all([
      consumePasswordReset(db, pr!.token, "NuevaClaveA2026"),
      consumePasswordReset(db, pr!.token, "NuevaClaveB2026"),
      consumePasswordReset(db, pr!.token, "NuevaClaveC2026"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Solo una de las claves sirve
    const winners = [];
    for (const pw of ["NuevaClaveA2026", "NuevaClaveB2026", "NuevaClaveC2026"]) {
      const r = await login(db, { email: users.cami, password: pw });
      if (r.ok) winners.push(pw);
    }
    expect(winners).toHaveLength(1);
    await sql`update staff_users set password_hash = ${await hashPassword(PW)} where email = ${users.cami}`.execute(
      db,
    );
  });

  it("consumir el token revoca todas las sesiones, invalida otros tokens pendientes y audita PASSWORD_RESET con staff_id", async () => {
    await reset(users.cami);
    await revokeAllSessions(db, (await staffRow(users.cami)).id);
    const s1 = await login(db, { email: users.cami, password: PW });
    const s2 = await login(db, { email: users.cami, password: PW });
    expect(s1.ok && s2.ok).toBe(true);
    const t1 = await createPasswordReset(db, users.cami);
    const t2 = await createPasswordReset(db, users.cami);
    expect(await consumePasswordReset(db, t2!.token, "OtraClave2026x")).toBe(true);
    // t1 quedó inutilizado
    expect(await consumePasswordReset(db, t1!.token, "OtraClave2026y")).toBe(false);
    if (s1.ok) expect(await resolveSession(db, s1.token)).toBeNull();
    if (s2.ok) expect(await resolveSession(db, s2.token)).toBeNull();
    const id = (await staffRow(users.cami)).id;
    const a = await sql<{
      staff_id: string | null;
      new_data: { sessions_revoked: number } | null;
    }>`select staff_id, new_data from audit_logs where action = 'PASSWORD_RESET' and entity_id = ${id} order by id desc limit 1`.execute(
      db,
    );
    expect(a.rows[0]?.staff_id).toBe(id);
    expect(a.rows[0]?.new_data?.sessions_revoked).toBe(2);
    // El trigger de staff_users NO guarda el hash
    const trg = await sql<{
      n: number;
    }>`select count(*)::int as n from audit_logs where entity = 'staff_users' and (coalesce(new_data::text,'') like '%password_hash%' or coalesce(old_data::text,'') like '%password_hash%' or coalesce(new_data::text,'') like '%$argon2%')`.execute(
      db,
    );
    expect(trg.rows[0]?.n).toBe(0);
    await sql`update staff_users set password_hash = ${await hashPassword(PW)} where email = ${users.cami}`.execute(
      db,
    );
  });

  it("token vencido, token inventado y usuario desactivado no restablecen nada", async () => {
    const pr = await createPasswordReset(db, users.cami);
    await sql`update password_reset_tokens set expires_at = now() - interval '1 minute' where token_hash = encode(sha256(convert_to(${pr!.token}, 'utf8')), 'hex')`.execute(
      db,
    );
    expect(await consumePasswordReset(db, pr!.token, "ClaveVencida2026")).toBe(false);
    expect(
      await consumePasswordReset(db, "token-inventado-muy-largo-123456", "Clave2026xxxx"),
    ).toBe(false);
    expect(await createPasswordReset(db, users.inactiva)).toBeNull();
    expect(await createPasswordReset(db, "nadie@audit.local")).toBeNull();
  });

  it("la política de contraseña aplica también al restablecer (no se consume el token con clave débil)", async () => {
    const pr = await createPasswordReset(db, users.cami);
    await expect(consumePasswordReset(db, pr!.token, "corta1")).rejects.toThrow(/10 caracteres/);
    // El token sigue vivo porque la validación falló antes de marcarlo usado
    expect(await consumePasswordReset(db, pr!.token, "ClaveValida2026")).toBe(true);
    await sql`update staff_users set password_hash = ${await hashPassword(PW)} where email = ${users.cami}`.execute(
      db,
    );
  });
});

describe("cambio de contraseña por el usuario", () => {
  it("conserva la sesión actual, cierra las demás, invalida tokens de reset y audita PASSWORD_CHANGED", async () => {
    await reset(users.dani);
    const actual = await login(db, { email: users.dani, password: PW });
    const otra = await login(db, { email: users.dani, password: PW });
    expect(actual.ok && otra.ok).toBe(true);
    if (!actual.ok || !otra.ok) return;
    await createPasswordReset(db, users.dani);
    const r = await changePassword(db, actual.session.staff.id, "ClaveNueva2026", {
      keepSessionId: actual.session.sessionId,
    });
    expect(r.sessionsRevoked).toBe(1);
    expect(await resolveSession(db, actual.token)).not.toBeNull();
    expect(await resolveSession(db, otra.token)).toBeNull();
    const pend = await sql<{
      n: number;
    }>`select count(*)::int as n from password_reset_tokens where staff_id = ${actual.session.staff.id} and used_at is null`.execute(
      db,
    );
    expect(pend.rows[0]?.n).toBe(0);
    const a = await sql<{
      staff_id: string | null;
    }>`select staff_id from audit_logs where action = 'PASSWORD_CHANGED' and entity_id = ${actual.session.staff.id}`.execute(
      db,
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.staff_id).toBe(actual.session.staff.id);
    expect(await login(db, { email: users.dani, password: PW }).then((x) => x.ok)).toBe(false);
    expect(
      await login(db, { email: users.dani, password: "ClaveNueva2026" }).then((x) => x.ok),
    ).toBe(true);
  });

  it("rechaza repetir la contraseña actual y las que no cumplen la política", async () => {
    const id = (await staffRow(users.dani)).id;
    await expect(changePassword(db, id, "ClaveNueva2026")).rejects.toThrow(/distinta a la actual/);
    await expect(changePassword(db, id, "sinnumeros!!!")).rejects.toThrow(/letras y números/);
    await expect(changePassword(db, id, "a1".repeat(70))).rejects.toThrow(/demasiado larga/);
    expect(
      await verifyPassword(
        (
          await sql<{
            h: string;
          }>`select password_hash as h from staff_users where id = ${id}`.execute(db)
        ).rows[0]!.h,
        "ClaveNueva2026",
      ),
    ).toBe(true);
  });

  it("acepta contraseñas con espacios internos, Unicode y emoji (y las verifica tal cual)", async () => {
    const id = (await staffRow(users.dani)).id;
    const pw = "año nuevo 2026 🥐 ñ";
    await changePassword(db, id, pw);
    expect(await login(db, { email: users.dani, password: pw }).then((x) => x.ok)).toBe(true);
    expect(
      await login(db, { email: users.dani, password: pw.trim() + " " }).then((x) => x.ok),
    ).toBe(false);
    await sql`update staff_users set password_hash = ${await hashPassword(PW)} where email = ${users.dani}`.execute(
      db,
    );
  });
});

describe("revocación de sesiones", () => {
  it("revokeAllSessions con excepción conserva solo esa sesión", async () => {
    await reset(users.ana);
    const a = await login(db, { email: users.ana, password: PW });
    const b = await login(db, { email: users.ana, password: PW });
    if (!a.ok || !b.ok) throw new Error("login");
    const n = await revokeAllSessions(db, a.session.staff.id, b.session.sessionId);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await resolveSession(db, a.token)).toBeNull();
    expect(await resolveSession(db, b.token)).not.toBeNull();
    expect(await revokeAllSessions(db, a.session.staff.id)).toBe(1);
    expect(await resolveSession(db, b.token)).toBeNull();
  });
});
