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
};

/** Resuelve cliente por QR, código PDP, teléfono o email (find_customer). Nunca expone datos al cliente sin control. */
export async function findCustomer(q: string): Promise<PublicCustomer | null> {
  const query = q.trim();
  if (!query || query.length > 120) return null;
  const r = await sql<{
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
  }>`select id, full_name, public_code, qr_token, points_balance, lifetime_points, tier_key, total_orders, total_spent_cents, marketing_consent
     from find_customer(${query})`.execute(db());
  const c = r.rows[0];
  if (!c) return null;
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
  };
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
