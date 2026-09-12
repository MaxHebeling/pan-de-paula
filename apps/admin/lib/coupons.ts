import "server-only";
import { db, sql } from "./db";

export type CouponRow = {
  id: string;
  code: string;
  name: string | null;
  kind: "pct" | "amount" | "free_product";
  value_bps: number | null;
  value_cents: number | null;
  product_id: string | null;
  product_name: string | null;
  min_subtotal_cents: number;
  starts_at: Date | null;
  ends_at: Date | null;
  max_uses: number | null;
  max_uses_per_customer: number;
  channels: string[];
  segment: { tiers?: string[]; new_customers_only?: boolean };
  is_active: boolean;
  uses_count: number;
  created_at: Date;
  discount_total_cents: number;
  status: "active" | "inactive" | "scheduled" | "expired" | "exhausted";
};

const SELECT = sql`
  select c.id, c.code::text as code, c.name, c.kind::text as kind, c.value_bps, c.value_cents, c.product_id, p.name as product_name,
         c.min_subtotal_cents, c.starts_at, c.ends_at, c.max_uses, c.max_uses_per_customer, c.channels::text[] as channels, c.segment,
         c.is_active, c.uses_count, c.created_at,
         coalesce((select sum(discount_cents) from coupon_redemptions r where r.coupon_id = c.id), 0)::bigint as discount_total_cents,
         case when not c.is_active then 'inactive'
              when c.max_uses is not null and c.uses_count >= c.max_uses then 'exhausted'
              when c.ends_at is not null and c.ends_at < now() then 'expired'
              when c.starts_at is not null and c.starts_at > now() then 'scheduled'
              else 'active' end as status
  from coupons c left join products p on p.id = c.product_id`;

export async function listCoupons(opts: { q?: string; status?: string } = {}) {
  const conds = [sql`true`];
  if (opts.q)
    conds.push(sql`(c.code ilike ${"%" + opts.q + "%"} or c.name ilike ${"%" + opts.q + "%"})`);
  const r = await sql<CouponRow>`
    select * from (${SELECT} where ${sql.join(conds, sql` and `)}) x
    ${opts.status ? sql`where x.status = ${opts.status}` : sql``}
    order by (x.status = 'active') desc, x.created_at desc limit 300`.execute(db());
  return r.rows;
}

export async function getCoupon(id: string): Promise<CouponRow | null> {
  const r = await sql<CouponRow>`${SELECT} where c.id = ${id}`.execute(db());
  return r.rows[0] ?? null;
}

export async function couponRedemptions(couponId: string) {
  const r = await sql<{
    id: string;
    discount_cents: number;
    created_at: Date;
    folio: string | null;
    order_id: string | null;
    customer_id: string | null;
    customer_name: string | null;
    public_code: string | null;
    channel: string | null;
    total_cents: number | null;
  }>`
    select r.id, r.discount_cents, r.created_at, o.folio, o.id as order_id, c.id as customer_id, c.full_name as customer_name, c.public_code, o.channel::text as channel, o.total_cents
    from coupon_redemptions r
    left join orders o on o.id = r.order_id
    left join customers c on c.id = r.customer_id
    where r.coupon_id = ${couponId} order by r.created_at desc limit 200`.execute(db());
  return r.rows;
}

export async function couponStats() {
  const r = await sql<{ active: number; uses_30d: number; discount_30d: number; total: number }>`
    select (select count(*) from coupons where is_active and (ends_at is null or ends_at >= now()) and (max_uses is null or uses_count < max_uses))::int as active,
           (select count(*) from coupon_redemptions where created_at >= now() - interval '30 days')::int as uses_30d,
           coalesce((select sum(discount_cents) from coupon_redemptions where created_at >= now() - interval '30 days'), 0)::int as discount_30d,
           (select count(*) from coupons)::int as total`.execute(db());
  return r.rows[0]!;
}

export const COUPON_KIND_LABELS: Record<string, string> = {
  pct: "Porcentaje",
  amount: "Monto fijo",
  free_product: "Producto gratis",
};
export const COUPON_STATUS: Record<
  string,
  { label: string; tone: "green" | "gray" | "blue" | "red" | "amber" }
> = {
  active: { label: "activo", tone: "green" },
  inactive: { label: "inactivo", tone: "gray" },
  scheduled: { label: "programado", tone: "blue" },
  expired: { label: "vencido", tone: "red" },
  exhausted: { label: "agotado", tone: "amber" },
};
export const VALIDATE_REASONS: Record<string, string> = {
  empty: "Código vacío",
  not_found: "El cupón no existe",
  inactive: "El cupón está desactivado",
  not_started: "Todavía no inicia su vigencia",
  expired: "El cupón venció",
  exhausted: "Se agotaron los usos",
  channel: "No aplica en este canal",
  min_subtotal: "No alcanza el mínimo de compra",
  customer_limit: "El cliente ya lo usó el máximo de veces",
  segment: "El cliente no pertenece al segmento",
  requires_customer: "Requiere identificar al cliente",
  product_not_in_cart: "El producto del cupón no está en la compra",
};
