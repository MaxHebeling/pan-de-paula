import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, sql } from "@pdp/db";
import {
  hashPassword,
  verifyPassword,
  login,
  resolveSession,
  logout,
  hasPermission,
  createPasswordReset,
  consumePasswordReset,
} from "../src/index.ts";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });
// Base propia (sufijo _auth) para no chocar con la suite de @pdp/db, que recrea la suya en paralelo.
const base = new URL(process.env.DATABASE_URL_TEST!);
base.pathname = base.pathname.replace(/\/?$/, "") + "_auth";
const url = base.toString();
const { db } = createDb({ connectionString: url, ssl: false, max: 2 });

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
  await sql`truncate staff_sessions, login_attempts, password_reset_tokens, staff_users restart identity cascade`.execute(
    db,
  );
  await sql`insert into staff_users(email, full_name, password_hash, role_key) values ('caja@pdp.local', 'Caja Uno', ${await hashPassword("ClaveSegura123")}, 'cashier')`.execute(
    db,
  );
});
afterAll(async () => {
  await db.destroy();
});

describe("password", () => {
  it("hashea y verifica; rechaza políticas débiles", async () => {
    const h = await hashPassword("Segura12345");
    expect(await verifyPassword(h, "Segura12345")).toBe(true);
    expect(await verifyPassword(h, "otra")).toBe(false);
    await expect(hashPassword("corta1")).rejects.toThrow(/10 caracteres/);
    await expect(hashPassword("sinnumeros!!")).rejects.toThrow(/letras y números/);
  });
});

describe("login/session", () => {
  it("login correcto crea sesión resoluble con permisos del rol", async () => {
    const r = await login(db, {
      email: "CAJA@pdp.local",
      password: "ClaveSegura123",
      ip: "127.0.0.1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await resolveSession(db, r.token);
    expect(s?.staff.email).toBe("caja@pdp.local");
    expect(hasPermission(s, "pos.sell")).toBe(true);
    expect(hasPermission(s, "staff.write")).toBe(false);
    await logout(db, r.token);
    expect(await resolveSession(db, r.token)).toBeNull();
  });

  it("bloquea tras 5 intentos fallidos", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await login(db, {
        email: "caja@pdp.local",
        password: "mala-clave-1",
        ip: "10.0.0.1",
      });
      expect(r.ok).toBe(false);
    }
    const r = await login(db, {
      email: "caja@pdp.local",
      password: "ClaveSegura123",
      ip: "10.0.0.1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("locked");
    await sql`update staff_users set failed_logins = 0, locked_until = null`.execute(db);
  });

  it("token inválido no resuelve sesión", async () => {
    expect(await resolveSession(db, "x".repeat(40))).toBeNull();
    expect(await resolveSession(db, "")).toBeNull();
  });

  it("reset de contraseña: token de un solo uso y revoca sesiones", async () => {
    const l = await login(db, { email: "caja@pdp.local", password: "ClaveSegura123" });
    expect(l.ok).toBe(true);
    const pr = await createPasswordReset(db, "caja@pdp.local");
    expect(pr).not.toBeNull();
    expect(await consumePasswordReset(db, pr!.token, "NuevaClave2026")).toBe(true);
    expect(await consumePasswordReset(db, pr!.token, "NuevaClave2026")).toBe(false);
    if (l.ok) expect(await resolveSession(db, l.token)).toBeNull();
    const again = await login(db, { email: "caja@pdp.local", password: "NuevaClave2026" });
    expect(again.ok).toBe(true);
    expect(await createPasswordReset(db, "nadie@pdp.local")).toBeNull();
  });
});
