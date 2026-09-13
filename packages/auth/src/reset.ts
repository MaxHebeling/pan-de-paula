import { sql, type Database } from "@pdp/db";
import { hashPassword, verifyPassword } from "./password.ts";
import { hashToken, newToken } from "./tokens.ts";
import { revokeAllSessions } from "./session.ts";

/** Crea un token de restablecimiento (1 hora). Devuelve null si el email no existe (la UI responde igual). */
export async function createPasswordReset(
  db: Database,
  email: string,
): Promise<{ token: string; staffId: string } | null> {
  const u = await sql<{
    id: string;
  }>`select id from staff_users where email = ${email.trim().toLowerCase()} and deleted_at is null and is_active`.execute(
    db,
  );
  const id = u.rows[0]?.id;
  if (!id) return null;
  const token = newToken(24);
  await sql`insert into password_reset_tokens(staff_id, token_hash, expires_at) values (${id}, ${hashToken(token)}, now() + interval '1 hour')`.execute(
    db,
  );
  return { token, staffId: id };
}

/**
 * Consume un token de restablecimiento. Atómico: el token se marca usado en la misma sentencia que lo valida
 * (dos peticiones simultáneas no pueden usarlo las dos). Cambia la contraseña, invalida los demás tokens
 * pendientes del usuario, revoca TODAS sus sesiones y deja rastro en audit_logs (staff_id = el propio usuario).
 */
export async function consumePasswordReset(
  db: Database,
  token: string,
  newPassword: string,
): Promise<boolean> {
  const th = hashToken(token);
  const ph = await hashPassword(newPassword);
  return db.transaction().execute(async (trx) => {
    const r = await sql<{
      staff_id: string;
    }>`update password_reset_tokens set used_at = now()
        where token_hash = ${th} and used_at is null and expires_at > now()
        returning staff_id`.execute(trx);
    const staffId = r.rows[0]?.staff_id;
    if (!staffId) return false;
    const u = await sql<{
      id: string;
    }>`select id from staff_users where id = ${staffId} and deleted_at is null and is_active`.execute(
      trx,
    );
    if (!u.rows[0]) return false;
    await sql`select set_config('app.staff_id', ${staffId}, true)`.execute(trx);
    await sql`update staff_users set password_hash = ${ph}, must_change_password = false, failed_logins = 0, locked_until = null where id = ${staffId}`.execute(
      trx,
    );
    await sql`update password_reset_tokens set used_at = now() where staff_id = ${staffId} and used_at is null`.execute(
      trx,
    );
    const revoked = await revokeAllSessions(trx, staffId);
    await sql`insert into audit_logs(staff_id, action, entity, entity_id, new_data)
      values (${staffId}, 'PASSWORD_RESET', 'staff_users', ${staffId}, ${JSON.stringify({ sessions_revoked: revoked })}::jsonb)`.execute(
      trx,
    );
    return true;
  });
}

/**
 * Cambio de contraseña por el propio usuario. Revoca las demás sesiones (conserva `keepSessionId`, la actual)
 * y registra PASSWORD_CHANGED en audit_logs. Lanza si la nueva contraseña no cumple la política o es igual a la actual.
 */
export async function changePassword(
  db: Database,
  staffId: string,
  newPassword: string,
  opts: { keepSessionId?: string } = {},
): Promise<{ sessionsRevoked: number }> {
  const ph = await hashPassword(newPassword);
  return db.transaction().execute(async (trx) => {
    const cur = await sql<{
      password_hash: string;
    }>`select password_hash from staff_users where id = ${staffId} and deleted_at is null for update`.execute(
      trx,
    );
    const current = cur.rows[0];
    if (!current) throw new Error("Usuario no encontrado");
    if (await verifyPassword(current.password_hash, newPassword))
      throw new Error("La nueva contraseña debe ser distinta a la actual");
    await sql`select set_config('app.staff_id', ${staffId}, true)`.execute(trx);
    await sql`update staff_users set password_hash = ${ph}, must_change_password = false where id = ${staffId}`.execute(
      trx,
    );
    await sql`update password_reset_tokens set used_at = now() where staff_id = ${staffId} and used_at is null`.execute(
      trx,
    );
    const sessionsRevoked = await revokeAllSessions(trx, staffId, opts.keepSessionId);
    await sql`insert into audit_logs(staff_id, action, entity, entity_id, new_data)
      values (${staffId}, 'PASSWORD_CHANGED', 'staff_users', ${staffId}, ${JSON.stringify({ sessions_revoked: sessionsRevoked })}::jsonb)`.execute(
      trx,
    );
    return { sessionsRevoked };
  });
}
