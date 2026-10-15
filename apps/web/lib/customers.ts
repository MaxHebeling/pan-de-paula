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

/**
 * Forma de un qr_token: 24 caracteres (18 bytes), con margen por si cambia la longitud.
 *
 * Se admiten los dos alfabetos a propósito. Los tokens históricos son base64 estándar (`+` y `/`,
 * el default de la migración 0004) y los nuevos son base64url (`-` y `_`, migración 0083): las
 * tarjetas ya repartidas tienen que seguir funcionando.
 */
const QR_TOKEN_RE = /^[A-Za-z0-9+/=_-]{16,64}$/;
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

/**
 * Devuelve el token tal como está guardado, deshaciendo lo que los lectores de QR le hacen.
 *
 * El token histórico es base64 estándar, así que puede llevar `+` y `/`. `cardUrl` los codifica
 * (`%2B`, `%2F`) y así la URL es correcta — pero el QR impreso lo lee una cámara, y muchas
 * decodifican antes de navegar. Medido contra producción el 15/10/2026, con el MISMO token:
 *
 *   /mi-tarjeta/<token con %2F>  → 200
 *   /mi-tarjeta/<token con / >   → 404   ← el lector decodificó
 *   /mi-tarjeta/<token con %20>  → 404   ← el lector trató el `+` como espacio
 *
 * Afectaba a 9 de los 14 socios: los 4 cuyo token lleva `/` y los 6 que llevan `+` (uno, ambos).
 * Por eso fallaba "solo a algunos" y parecía aleatorio.
 *
 * Se arregla sin reemitir ninguna tarjeta: la ruta es comodín (`[...token]`) y vuelve a unir los
 * segmentos con `/`, y aquí se restituye el `+` que llegó como espacio. Un espacio nunca es parte
 * de un token legítimo, así que la conversión no puede confundir dos tokens distintos.
 */
export function decodeToken(raw: string): string {
  let t = raw;
  if (t.includes("%")) {
    try {
      t = decodeURIComponent(t);
    } catch {
      // Secuencia de escape mal formada: se sigue con el valor tal cual.
    }
  }
  // El recorte va ANTES de restituir el `+`: si no, un espacio al final se convertiría en un `+`
  // que ya nadie quita y el token dejaría de coincidir.
  return t.trim().replace(/ /g, "+");
}
