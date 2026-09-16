/**
 * Sesiones de CLIENTE (portal del sitio público), con el mismo diseño que las sesiones de staff:
 *   - Enlace de acceso: token aleatorio de un solo uso; en la base solo su sha256 y una caducidad corta
 *     (mismo patrón que `password_reset_tokens`).
 *   - Sesión: cookie httpOnly con el token en claro; en la base `customer_sessions` guarda su sha256,
 *     `expires_at`, `last_seen_at` y `revoked_at` (mismo patrón que `staff_sessions`).
 *
 * No hay contraseñas de cliente: la identidad se demuestra teniendo el enlace enviado a su correo
 * (o entregado por el staff desde el CRM mientras el proveedor de correo no esté configurado).
 *
 * Este módulo se importa desde `apps/web` (portal) y desde `apps/admin` (generar el enlace), por eso
 * vive en `@pdp/auth` y se expone también como `@pdp/auth/customer` (sin arrastrar argon2).
 */
import { sql, type Database, type DB, type Transaction } from "@pdp/db";
import { hashToken, newToken } from "./tokens.ts";
import { normalizeIp } from "./ip.ts";

export const CUSTOMER_SESSION_COOKIE = "pdp_cliente";
/** Vida máxima absoluta de la sesión desde que se creó (alineada con la cookie). */
export const CUSTOMER_SESSION_TTL_DAYS = 30;
/** El enlace de acceso caduca pronto: es la única credencial del cliente. */
export const CUSTOMER_ACCESS_TTL_MINUTES = 60;

export type CustomerSession = {
  sessionId: string;
  customer: {
    id: string;
    fullName: string;
    publicCode: string;
    qrToken: string;
    email: string | null;
  };
  expiresAt: Date;
};

type Exec = Database | Transaction<DB>;

/**
 * Cliente activo con ese correo. Devuelve null si no existe (quien llama responde SIEMPRE lo mismo
 * exista o no la cuenta: nunca se revela qué correos están registrados).
 */
export async function findCustomerByEmail(
  db: Exec,
  email: string,
): Promise<{ id: string; fullName: string; email: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return null;
  const r = await sql<{ id: string; full_name: string; email: string }>`
    select id, full_name, email from customers
     where email = ${normalized} and deleted_at is null and merged_into_id is null
     limit 1`.execute(db);
  const row = r.rows[0];
  return row ? { id: row.id, fullName: row.full_name, email: row.email } : null;
}

/**
 * Crea un enlace de acceso de un solo uso. Invalida los enlaces pendientes anteriores del mismo
 * cliente (solo el último sirve) y deja rastro en `audit_logs` + `domain_events`.
 * `staffId` se pasa cuando lo genera una persona desde el CRM.
 */
export async function createCustomerAccessToken(
  db: Exec,
  input: {
    customerId: string;
    requestedBy: "self" | "staff";
    staffId?: string | null;
    ip?: string | null;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken(24);
  const ip = normalizeIp(input.ip);
  const expiresAt = new Date(Date.now() + CUSTOMER_ACCESS_TTL_MINUTES * 60_000);
  await sql`update customer_access_tokens set used_at = now()
             where customer_id = ${input.customerId} and used_at is null and expires_at > now()`.execute(
    db,
  );
  await sql`insert into customer_access_tokens(customer_id, token_hash, requested_by, staff_id, ip, expires_at)
            values (${input.customerId}, ${hashToken(token)}, ${input.requestedBy}, ${input.staffId ?? null}, ${ip}::inet, ${expiresAt})`.execute(
    db,
  );
  await sql`insert into audit_logs(staff_id, action, entity, entity_id, new_data, ip)
            values (${input.staffId ?? null}, 'CUSTOMER_ACCESS_LINK', 'customers', ${input.customerId},
                    ${JSON.stringify({ requested_by: input.requestedBy, expires_at: expiresAt.toISOString() })}::jsonb, ${ip}::inet)`.execute(
    db,
  );
  return { token, expiresAt };
}

/**
 * Canjea el enlace y abre la sesión. Atómico: el token se marca usado en la misma sentencia que lo
 * valida, así que dos peticiones simultáneas no pueden usarlo las dos.
 * Devuelve el token de sesión (va a la cookie) o null si el enlace es inválido, caducado o ya usado.
 */
export async function consumeCustomerAccessToken(
  db: Database,
  rawToken: string | null | undefined,
  opts: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; session: CustomerSession } | null> {
  if (!rawToken || rawToken.length < 20 || rawToken.length > 200) return null;
  const th = hashToken(rawToken);
  const ip = normalizeIp(opts.ip);
  const userAgent = opts.userAgent ? opts.userAgent.slice(0, 512) : null;
  return db.transaction().execute(async (trx) => {
    const t = await sql<{ customer_id: string }>`
      update customer_access_tokens set used_at = now()
       where token_hash = ${th} and used_at is null and expires_at > now()
       returning customer_id`.execute(trx);
    const customerId = t.rows[0]?.customer_id;
    if (!customerId) return null;
    const c = await sql<{
      id: string;
      full_name: string;
      public_code: string;
      qr_token: string;
      email: string | null;
    }>`select id, full_name, public_code, qr_token, email from customers
        where id = ${customerId} and deleted_at is null and merged_into_id is null`.execute(trx);
    const customer = c.rows[0];
    if (!customer) return null;
    const token = newToken();
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_TTL_DAYS * 86_400_000);
    const s = await sql<{ id: string }>`
      insert into customer_sessions(customer_id, token_hash, user_agent, ip, expires_at)
      values (${customerId}, ${hashToken(token)}, ${userAgent}, ${ip}::inet, ${expiresAt}) returning id`.execute(
      trx,
    );
    await sql`insert into audit_logs(staff_id, action, entity, entity_id, ip)
              values (null, 'CUSTOMER_LOGIN', 'customers', ${customerId}, ${ip}::inet)`.execute(
      trx,
    );
    await sql`select emit_event('CUSTOMER_PORTAL_LOGIN', 'customer', ${customerId}, '{}'::jsonb)`.execute(
      trx,
    );
    return {
      token,
      session: {
        sessionId: s.rows[0]!.id,
        customer: {
          id: customer.id,
          fullName: customer.full_name,
          publicCode: customer.public_code,
          qrToken: customer.qr_token,
          email: customer.email,
        },
        expiresAt,
      },
    };
  });
}

/**
 * Resuelve la sesión desde el token de la cookie. Renueva `last_seen_at` (throttled) y desliza la
 * expiración, pero NUNCA más allá de CUSTOMER_SESSION_TTL_DAYS desde su creación: un token robado no
 * se mantiene vivo indefinidamente por usarlo cada pocos días.
 */
export async function resolveCustomerSession(
  db: Database,
  token: string | undefined | null,
): Promise<CustomerSession | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const th = hashToken(token);
  const r = await sql<{
    session_id: string;
    expires_at: Date;
    last_seen_at: Date;
    id: string;
    full_name: string;
    public_code: string;
    qr_token: string;
    email: string | null;
  }>`select s.id as session_id, s.expires_at, s.last_seen_at,
            c.id, c.full_name, c.public_code, c.qr_token, c.email
       from customer_sessions s join customers c on c.id = s.customer_id
      where s.token_hash = ${th} and s.revoked_at is null and s.expires_at > now()
        and s.created_at > now() - (${CUSTOMER_SESSION_TTL_DAYS} || ' days')::interval
        and c.deleted_at is null and c.merged_into_id is null`.execute(db);
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await sql`update customer_sessions
                 set last_seen_at = now(),
                     expires_at = least(greatest(expires_at, now() + interval '7 days'),
                                        created_at + (${CUSTOMER_SESSION_TTL_DAYS} || ' days')::interval)
               where id = ${row.session_id}`.execute(db);
  }
  return {
    sessionId: row.session_id,
    customer: {
      id: row.id,
      fullName: row.full_name,
      publicCode: row.public_code,
      qrToken: row.qr_token,
      email: row.email,
    },
    expiresAt: new Date(row.expires_at),
  };
}

/** Cierra la sesión (revoca el token de la cookie) y deja rastro. Devuelve el cliente afectado. */
export async function logoutCustomer(
  db: Exec,
  token: string | undefined | null,
): Promise<string | null> {
  if (!token) return null;
  const r = await sql<{ customer_id: string }>`
    update customer_sessions set revoked_at = now()
     where token_hash = ${hashToken(token)} and revoked_at is null
     returning customer_id`.execute(db);
  const customerId = r.rows[0]?.customer_id ?? null;
  if (customerId) {
    await sql`insert into audit_logs(staff_id, action, entity, entity_id)
              values (null, 'CUSTOMER_LOGOUT', 'customers', ${customerId})`.execute(db);
  }
  return customerId;
}

/** Revoca todas las sesiones del cliente (p. ej. al cambiarle el correo desde el CRM). */
export async function revokeAllCustomerSessions(
  db: Exec,
  customerId: string,
  exceptSessionId?: string,
): Promise<number> {
  const r = await sql<{ n: number }>`
    with u as (update customer_sessions set revoked_at = now()
       where customer_id = ${customerId} and revoked_at is null
         and (${exceptSessionId ?? null}::uuid is null or id <> ${exceptSessionId ?? null}::uuid)
       returning 1) select count(*)::int as n from u`.execute(db);
  return r.rows[0]?.n ?? 0;
}

/** Limpieza periódica: sesiones caducadas/revocadas hace más de 30 días y enlaces vencidos. */
export async function purgeExpiredCustomerSessions(db: Database): Promise<number> {
  await sql`delete from customer_access_tokens where expires_at < now() - interval '7 days'`.execute(
    db,
  );
  const r = await sql<{ n: number }>`
    with d as (delete from customer_sessions
                where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'
                returning 1) select count(*)::int as n from d`.execute(db);
  return r.rows[0]?.n ?? 0;
}
