import { sql, type Database } from "@pdp/db";
import { hashPassword } from "./password.ts";
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

export async function consumePasswordReset(
  db: Database,
  token: string,
  newPassword: string,
): Promise<boolean> {
  const th = hashToken(token);
  const r = await sql<{
    id: string;
    staff_id: string;
  }>`select id, staff_id from password_reset_tokens where token_hash = ${th} and used_at is null and expires_at > now()`.execute(
    db,
  );
  const row = r.rows[0];
  if (!row) return false;
  const ph = await hashPassword(newPassword);
  await db.transaction().execute(async (trx) => {
    await sql`update staff_users set password_hash = ${ph}, must_change_password = false, failed_logins = 0, locked_until = null where id = ${row.staff_id}`.execute(
      trx,
    );
    await sql`update password_reset_tokens set used_at = now() where id = ${row.id}`.execute(trx);
  });
  await revokeAllSessions(db, row.staff_id);
  return true;
}

export async function changePassword(
  db: Database,
  staffId: string,
  newPassword: string,
): Promise<void> {
  const ph = await hashPassword(newPassword);
  await sql`update staff_users set password_hash = ${ph}, must_change_password = false where id = ${staffId}`.execute(
    db,
  );
}
