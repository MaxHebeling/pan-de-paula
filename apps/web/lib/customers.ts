import "server-only";
import { db, sql } from "@/lib/db";

export type PublicCustomer = {
  id: string;
  fullName: string;
  publicCode: string;
  qrToken: string;
  pointsBalance: number;
  lifetimePoints: number;
  tierKey: string | null;
  totalOrders: number;
  totalSpentCents: number;
  marketingConsent: boolean;
  email: string | null;
};

type Row = {
  id: string;
  full_name: string;
  public_code: string;
  qr_token: string;
  points_balance: number;
  lifetime_points: number;
  tier_key: string | null;
  total_orders: number;
  total_spent_cents: number;
  marketing_consent: boolean;
  email: string | null;
};

const COLS = sql`id, full_name, public_code, qr_token, points_balance, lifetime_points, tier_key, total_orders, total_spent_cents, marketing_consent, email`;

function map(c: Row): PublicCustomer {
  return {
    id: c.id,
    fullName: c.full_name,
    publicCode: c.public_code,
    qrToken: c.qr_token,
    pointsBalance: c.points_balance,
    lifetimePoints: c.lifetime_points,
    tierKey: c.tier_key,
    totalOrders: c.total_orders,
    totalSpentCents: Number(c.total_spent_cents),
    marketingConsent: c.marketing_consent,
    email: c.email,
  };
}

/**
 * Resuelve cliente por QR, código PDP, teléfono o email (find_customer, la misma búsqueda del POS).
 * SOLO para vincular en el servidor (checkout / cupones): el resultado nunca se muestra completo al visitante.
 * Para la tarjeta pública usa `findCustomerByQrToken`.
 */
export async function findCustomer(q: string): Promise<PublicCustomer | null> {
  const query = q.trim();
  if (!query || query.length > 120) return null;
  const r = await sql<Row>`select ${COLS} from find_customer(${query})`.execute(db());
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** Forma de un qr_token (base64 de 18 bytes = 24 caracteres; se admite margen por si cambia la longitud). */
const QR_TOKEN_RE = /^[A-Za-z0-9+/=]{16,64}$/;
export const isQrToken = (s: string): boolean => QR_TOKEN_RE.test(s);

/**
 * Tarjeta pública: resuelve ÚNICAMENTE por el token opaco `qr_token`. Un teléfono, correo o código PDP
 * (datos adivinables) nunca abren la tarjeta de otra persona.
 */
export async function findCustomerByQrToken(raw: string): Promise<PublicCustomer | null> {
  const token = decodeToken(raw).trim();
  if (!isQrToken(token)) return null;
  const r = await sql<Row>`select ${COLS} from customers c
     where c.qr_token = ${token} and c.deleted_at is null and c.merged_into_id is null
     limit 1`.execute(db());
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** "Ana López Ruiz" → "Ana L." (confirmación parcial, sin exponer el nombre completo). */
export function partialName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const second = parts[1]?.charAt(0);
  return second ? `${first} ${second}.` : first;
}

/** Los tokens de QR son base64 con "/" y "+": se codifican para la URL y se decodifican aquí. */
export function decodeToken(raw: string): string {
  try {
    return raw.includes("%") ? decodeURIComponent(raw) : raw;
  } catch {
    return raw;
  }
}
