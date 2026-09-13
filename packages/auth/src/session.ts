/**
 * Sesiones de staff basadas en cookie httpOnly + tabla staff_sessions.
 * El token en claro solo vive en la cookie; en la base se guarda su sha256.
 */
import { sql, type Database, type DB, type Transaction } from "@pdp/db";
import { hash } from "@node-rs/argon2";
import { hashToken, newToken } from "./tokens.ts";
import { verifyPassword } from "./password.ts";
import { normalizeIp } from "./ip.ts";

export const SESSION_COOKIE = "pdp_session";
export const SESSION_TTL_DAYS = 14;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const IP_ATTEMPT_LIMIT = 30; // por 15 minutos

export type StaffSession = {
  sessionId: string;
  staff: {
    id: string;
    email: string;
    fullName: string;
    roleKey: string;
    mustChangePassword: boolean;
  };
  permissions: Set<string>;
  expiresAt: Date;
};

export type LoginResult =
  | { ok: true; token: string; session: StaffSession }
  | { ok: false; reason: "invalid_credentials" | "locked" | "inactive" | "rate_limited" };

const DUMMY_HASH_PROMISE: { v?: Promise<string> } = {};
/** Hash de relleno para igualar el tiempo de respuesta cuando el correo no existe (evita enumerar por tiempo). */
function dummyHash(): Promise<string> {
  DUMMY_HASH_PROMISE.v ??= hash("no-existe-" + newToken(8), {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
  return DUMMY_HASH_PROMISE.v;
}

export async function login(
  db: Database,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  // La IP viene de cabeceras: si no es una IP válida se descarta (nunca se castea texto arbitrario a inet).
  const ip = normalizeIp(input.ip);
  const userAgent = input.userAgent ? input.userAgent.slice(0, 512) : null;
  // Rate limit por IP
  if (ip) {
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from login_attempts where ip = ${ip}::inet and success = false and created_at > now() - interval '15 minutes'`.execute(
      db,
    );
    if ((r.rows[0]?.n ?? 0) >= IP_ATTEMPT_LIMIT) return { ok: false, reason: "rate_limited" };
  }
  const u = await sql<{
    id: string;
    email: string;
    full_name: string;
    password_hash: string;
    role_key: string;
    is_active: boolean;
    must_change_password: boolean;
    failed_logins: number;
    locked_until: Date | null;
  }>`select id, email, full_name, password_hash, role_key, is_active, must_change_password, failed_logins, locked_until
     from staff_users where email = ${email} and deleted_at is null`.execute(db);
  const user = u.rows[0];
  const record = (success: boolean) =>
    sql`insert into login_attempts(email, ip, success) values (${email}, ${ip}::inet, ${success})`.execute(
      db,
    );

  if (!user) {
    // Mismo costo y misma respuesta que una cuenta real: verifica contra un hash de relleno y
    // "bloquea" el correo inexistente tras el mismo número de fallos (no se puede enumerar por bloqueo).
    await verifyPassword(await dummyHash(), input.password);
    await record(false);
    const f = await sql<{
      n: number;
    }>`select count(*)::int as n from login_attempts where email = ${email} and success = false and created_at > now() - (${LOCK_MINUTES} || ' minutes')::interval`.execute(
      db,
    );
    return {
      ok: false,
      reason: (f.rows[0]?.n ?? 0) >= MAX_FAILED_LOGINS ? "locked" : "invalid_credentials",
    };
  }
  const lockActive = !!user.locked_until && new Date(user.locked_until) > new Date();
  if (lockActive) {
    await record(false);
    return { ok: false, reason: "locked" };
  }
  const okPw = await verifyPassword(user.password_hash, input.password);
  if (!okPw) {
    await record(false);
    // Si el bloqueo anterior ya venció, el contador arranca de nuevo (si no, un solo fallo re-bloquea 15 min).
    const failed = (user.locked_until ? 0 : user.failed_logins) + 1;
    await sql`update staff_users set failed_logins = ${failed},
              locked_until = case when ${failed} >= ${MAX_FAILED_LOGINS} then now() + (${LOCK_MINUTES} || ' minutes')::interval else null end
              where id = ${user.id}`.execute(db);
    return { ok: false, reason: failed >= MAX_FAILED_LOGINS ? "locked" : "invalid_credentials" };
  }
  if (!user.is_active) {
    // Solo quien conoce la contraseña se entera de que la cuenta está desactivada.
    await record(false);
    return { ok: false, reason: "inactive" };
  }
  await record(true);
  await sql`update staff_users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${user.id}`.execute(
    db,
  );
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  const s = await sql<{
    id: string;
  }>`insert into staff_sessions(staff_id, token_hash, user_agent, ip, expires_at)
      values (${user.id}, ${hashToken(token)}, ${userAgent}, ${ip}::inet, ${expiresAt}) returning id`.execute(
    db,
  );
  const permissions = await loadPermissions(db, user.role_key);
  await sql`insert into audit_logs(staff_id, action, entity, entity_id, ip) values (${user.id}, 'LOGIN', 'staff_users', ${user.id}, ${ip}::inet)`.execute(
    db,
  );
  return {
    ok: true,
    token,
    session: {
      sessionId: s.rows[0]!.id,
      staff: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        roleKey: user.role_key,
        mustChangePassword: user.must_change_password,
      },
      permissions,
      expiresAt,
    },
  };
}

export async function loadPermissions(db: Database, roleKey: string): Promise<Set<string>> {
  const r = await sql<{
    permission_key: string;
  }>`select permission_key from role_permissions where role_key = ${roleKey}`.execute(db);
  return new Set(r.rows.map((x) => x.permission_key));
}

/** Resuelve la sesión desde el token de cookie. Renueva last_seen (throttled) y desliza expiración. */
export async function resolveSession(
  db: Database,
  token: string | undefined | null,
): Promise<StaffSession | null> {
  if (!token || token.length < 20) return null;
  const th = hashToken(token);
  const r = await sql<{
    session_id: string;
    expires_at: Date;
    last_seen_at: Date;
    id: string;
    email: string;
    full_name: string;
    role_key: string;
    must_change_password: boolean;
    is_active: boolean;
  }>`select s.id as session_id, s.expires_at, s.last_seen_at, u.id, u.email, u.full_name, u.role_key, u.must_change_password, u.is_active
     from staff_sessions s join staff_users u on u.id = s.staff_id
     where s.token_hash = ${th} and s.revoked_at is null and s.expires_at > now() and u.deleted_at is null`.execute(
    db,
  );
  const row = r.rows[0];
  if (!row || !row.is_active) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await sql`update staff_sessions set last_seen_at = now(), expires_at = greatest(expires_at, now() + interval '7 days') where id = ${row.session_id}`.execute(
      db,
    );
  }
  const permissions = await loadPermissions(db, row.role_key);
  return {
    sessionId: row.session_id,
    staff: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      roleKey: row.role_key,
      mustChangePassword: row.must_change_password,
    },
    permissions,
    expiresAt: new Date(row.expires_at),
  };
}

export async function logout(db: Database, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await sql`update staff_sessions set revoked_at = now() where token_hash = ${hashToken(token)} and revoked_at is null`.execute(
    db,
  );
}

/** Revoca todas las sesiones del usuario; `exceptSessionId` conserva la sesión actual (p. ej. al cambiar contraseña). */
export async function revokeAllSessions(
  db: Database | Transaction<DB>,
  staffId: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await sql<{
    n: number;
  }>`with u as (update staff_sessions set revoked_at = now()
      where staff_id = ${staffId} and revoked_at is null and (${exceptSessionId ?? null}::uuid is null or id <> ${exceptSessionId ?? null}::uuid)
      returning 1) select count(*)::int as n from u`.execute(db);
  return r.rows[0]?.n ?? 0;
}

export async function purgeExpiredSessions(db: Database): Promise<number> {
  const r = await sql<{
    n: number;
  }>`with d as (delete from staff_sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days' returning 1) select count(*)::int as n from d`.execute(
    db,
  );
  return r.rows[0]?.n ?? 0;
}

export function hasPermission(session: StaffSession | null, permission: string): boolean {
  if (!session) return false;
  if (session.staff.roleKey === "super_admin") return true;
  return session.permissions.has(permission);
}

export function requirePermission(
  session: StaffSession | null,
  permission: string,
): asserts session is StaffSession {
  if (!hasPermission(session, permission)) {
    const e = new Error(`Permiso requerido: ${permission}`) as Error & { status: number };
    e.status = session ? 403 : 401;
    throw e;
  }
}
