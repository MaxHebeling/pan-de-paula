import "server-only";
import { sql } from "@pdp/db";
import { phoneToE164Digits } from "@pdp/domain";
import type { StaffSession } from "@pdp/auth";
import { dbErrorMessage } from "@pdp/db";

/** Resultado estándar de una server action de operación. */
export type ActionResult<T = undefined> =
  { ok: true; data: T; message?: string } | { ok: false; error: string };

export function fail(e: unknown, context: string): { ok: false; error: string } {
  const { message, code } = dbErrorMessage(e);
  console.error(`[ops] ${context}`, { code, message });
  return { ok: false, error: message };
}

/** Zona horaria del negocio como expresión SQL (business_settings.timezone). */
export const TZ = sql`(select timezone from business_settings where id = 1)`;

/** Fecha local del negocio (date) de un timestamptz. */
export const localDate = (col: ReturnType<typeof sql>) => sql`(${col} at time zone ${TZ})::date`;

/** Hoy en la zona horaria del negocio. */
export const TODAY = sql`(now() at time zone ${TZ})::date`;

const MANAGER_ROLES = new Set(["super_admin", "owner", "manager"]);
export function isManager(session: StaffSession): boolean {
  return MANAGER_ROLES.has(session.staff.roleKey);
}

/** "45.50" | "45" → 4550. Devuelve null si no es un monto válido. */
export function parseMoneyCents(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .replace(/[^0-9.,-]/g, "")
    .replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Convierte un `datetime-local` (hora del negocio) a ISO con zona horaria del negocio. */
export function localDateTimeToSql(value: string): string | null {
  if (!value) return null;
  // Se guarda como texto y Postgres lo interpreta en la zona del negocio (`at time zone`).
  return value.replace("T", " ");
}

/**
 * Número para wa.me. México (10 dígitos guardados) se marca como 52 + 10; un teléfono guardado en
 * E.164 ("+16195550100") ya trae su prefijo y se usa tal cual. La regla vive en `@pdp/domain`
 * (`phoneToE164Digits`) para que el sitio y el CRM armen el mismo enlace.
 */
export function whatsappNumber(phone: string | null | undefined): string | null {
  return phoneToE164Digits(phone);
}
