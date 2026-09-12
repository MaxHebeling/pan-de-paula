import "server-only";
import { normalizePhone, isCustomerCode } from "@pdp/domain";
import { db, sql } from "./db";

export type CustomerRow = {
  id: string;
  public_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  tier_key: string | null;
  tier_name: string | null;
  tier_color: string | null;
  points_balance: number;
  total_orders: number;
  total_spent_cents: number;
  last_purchase_at: Date | null;
  birthday: string | null;
  marketing_consent: boolean;
  created_at: Date;
};

export type CustomerFilters = {
  q?: string;
  tier?: string;
  seg?: "frequent" | "inactive" | "birthday" | "marketing" | "";
  page?: number;
};

export const PAGE_SIZE = 50;

/** Construye la condición de búsqueda por nombre/teléfono/email/código. */
export function customerSearchCondition(q: string) {
  const term = q.trim();
  if (!term) return sql`true`;
  if (isCustomerCode(term)) return sql`c.public_code = upper(${term})`;
  const digits = normalizePhone(term).replace(/\D/g, "");
  const like = `%${term}%`;
  const parts = [
    sql`c.full_name ilike ${like}`,
    sql`c.email ilike ${like}`,
    sql`c.public_code ilike ${like}`,
  ];
  if (digits.length >= 4)
    parts.push(
      sql`regexp_replace(coalesce(c.phone::text, ''), '\\D', '', 'g') like ${"%" + digits + "%"}`,
    );
  return sql`(${sql.join(parts, sql` or `)})`;
}

export async function listCustomers(f: CustomerFilters) {
  const page = Math.max(1, f.page ?? 1);
  const conds = [
    sql`c.deleted_at is null`,
    sql`c.merged_into_id is null`,
    customerSearchCondition(f.q ?? ""),
  ];
  if (f.tier) conds.push(sql`c.tier_key = ${f.tier}`);
  switch (f.seg) {
    case "frequent":
      conds.push(
        sql`(select count(distinct date_trunc('week', s.sold_at at time zone bs.timezone)) from sales s, business_settings bs
             where bs.id = 1 and s.customer_id = c.id and s.voided_at is null and s.sold_at >= now() - interval '28 days') >= 4`,
      );
      break;
    case "inactive":
      conds.push(sql`c.last_purchase_at < now() - interval '30 days'`);
      break;
    case "birthday":
      conds.push(
        sql`c.birthday is not null and extract(month from c.birthday) = extract(month from now() at time zone (select timezone from business_settings where id = 1))`,
      );
      break;
    case "marketing":
      conds.push(sql`c.marketing_consent`);
      break;
  }
  const where = sql.join(conds, sql` and `);
  const [rows, total] = await Promise.all([
    sql<CustomerRow>`
      select c.id, c.public_code, c.full_name, c.phone::text as phone, c.email::text as email, c.tier_key,
             t.name as tier_name, t.color as tier_color, c.points_balance, c.total_orders, c.total_spent_cents,
             c.last_purchase_at, c.birthday::text as birthday, c.marketing_consent, c.created_at
      from customers c left join loyalty_tiers t on t.key = c.tier_key
      where ${where}
      order by c.last_purchase_at desc nulls last, c.created_at desc
      limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`.execute(db()),
    sql<{ n: number }>`select count(*)::int as n from customers c where ${where}`.execute(db()),
  ]);
  return {
    rows: rows.rows,
    total: total.rows[0]?.n ?? 0,
    page,
    pages: Math.max(1, Math.ceil((total.rows[0]?.n ?? 0) / PAGE_SIZE)),
  };
}

export async function customerCounts() {
  const r = await sql<{
    total: number;
    frequent: number;
    inactive: number;
    birthday: number;
    marketing: number;
  }>`
    with base as (select c.* from customers c where c.deleted_at is null and c.merged_into_id is null),
    bs as (select timezone from business_settings where id = 1)
    select (select count(*) from base)::int as total,
           (select count(*) from base c where (select count(distinct date_trunc('week', s.sold_at at time zone bs.timezone)) from sales s, bs
              where s.customer_id = c.id and s.voided_at is null and s.sold_at >= now() - interval '28 days') >= 4)::int as frequent,
           (select count(*) from base where last_purchase_at < now() - interval '30 days')::int as inactive,
           (select count(*) from base, bs where birthday is not null and extract(month from birthday) = extract(month from now() at time zone bs.timezone))::int as birthday,
           (select count(*) from base where marketing_consent)::int as marketing`.execute(db());
  return r.rows[0]!;
}

export async function loyaltyTiers() {
  const r = await sql<{
    key: string;
    name: string;
    rank: number;
    min_orders: number;
    min_spent_cents: number;
    min_lifetime_points: number;
    perks: string | null;
    color: string | null;
  }>`select key, name, rank, min_orders, min_spent_cents, min_lifetime_points, perks, color from loyalty_tiers order by rank`.execute(
    db(),
  );
  return r.rows;
}

export type CustomerDetail = {
  id: string;
  public_code: string;
  qr_token: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  notes: string | null;
  tags: string[];
  source: string;
  operational_consent: boolean;
  marketing_consent: boolean;
  marketing_opt_out_at: Date | null;
  tier_key: string | null;
  points_balance: number;
  lifetime_points: number;
  total_orders: number;
  total_spent_cents: number;
  first_purchase_at: Date | null;
  last_purchase_at: Date | null;
  merged_into_id: string | null;
  merged_into_code: string | null;
  days_since_purchase: number | null;
  created_at: Date;
  deleted_at: Date | null;
};

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const r = await sql<CustomerDetail>`
    select c.id, c.public_code, c.qr_token, c.full_name, c.phone::text as phone, c.email::text as email, c.birthday::text as birthday,
           c.notes, c.tags, c.source, c.operational_consent, c.marketing_consent, c.marketing_opt_out_at, c.tier_key,
           c.points_balance, c.lifetime_points, c.total_orders, c.total_spent_cents, c.first_purchase_at, c.last_purchase_at,
           c.merged_into_id, m.public_code as merged_into_code,
           case when c.last_purchase_at is not null then extract(day from now() - c.last_purchase_at)::int end as days_since_purchase,
           c.created_at, c.deleted_at
    from customers c left join customers m on m.id = c.merged_into_id
    where c.id = ${id}`.execute(db());
  return r.rows[0] ?? null;
}

export async function customer360(id: string) {
  const d = db();
  const [
    ledger,
    orders,
    favorites,
    events,
    addresses,
    redemptions,
    rewards,
    duplicates,
    mergedFrom,
    coupons,
  ] = await Promise.all([
    sql<{
      id: number;
      kind: string;
      points: number;
      balance_after: number;
      note: string | null;
      created_at: Date;
      staff_name: string | null;
      folio: string | null;
    }>`select lt.id, lt.kind::text as kind, lt.points, lt.balance_after, lt.note, lt.created_at, su.full_name as staff_name, o.folio
         from loyalty_transactions lt
         left join staff_users su on su.id = lt.staff_id
         left join sales s on s.id = lt.sale_id left join orders o on o.id = s.order_id
         where lt.customer_id = ${id} or lt.customer_id in (select id from customers where merged_into_id = ${id})
         order by lt.id desc limit 60`.execute(d),
    sql<{
      id: string;
      folio: string;
      channel: string;
      status: string;
      payment_status: string;
      total_cents: number;
      placed_at: Date;
      items: number;
      voided_at: Date | null;
      points: number;
      summary: string | null;
    }>`select o.id, o.folio, o.channel::text as channel, o.status::text as status, o.payment_status::text as payment_status,
                o.total_cents, o.placed_at, coalesce((select sum(qty) from order_items where order_id = o.id), 0)::numeric as items,
                s.voided_at,
                coalesce((select sum(points) from loyalty_transactions where sale_id = s.id and kind = 'earn'), 0)::int as points,
                (select string_agg(product_name || ' ×' || trim(to_char(qty, 'FM9999990.###')), ', ' order by sort_order) from order_items where order_id = o.id) as summary
         from orders o left join sales s on s.order_id = o.id
         where o.customer_id = ${id}
         order by o.placed_at desc limit 60`.execute(d),
    sql<{ product_id: string | null; name: string; units: string; revenue: number; last: Date }>`
         select oi.product_id, oi.product_name as name, sum(oi.qty)::numeric as units, sum(oi.total_cents)::bigint as revenue, max(s.sold_at) as last
         from sales s join order_items oi on oi.order_id = s.order_id
         where s.customer_id = ${id} and s.voided_at is null
         group by oi.product_id, oi.product_name order by units desc, revenue desc limit 8`.execute(
      d,
    ),
    sql<{
      id: number;
      kind: string;
      payload: Record<string, unknown>;
      handled_at: Date | null;
      created_at: Date;
    }>`
         select id, kind, payload, handled_at, created_at from customer_events where customer_id = ${id} order by created_at desc limit 40`.execute(
      d,
    ),
    sql<{
      id: string;
      label: string | null;
      street: string;
      neighborhood: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      references_note: string | null;
      is_default: boolean;
    }>`select id, label, street, neighborhood, city, state, postal_code, references_note, is_default
         from customer_addresses where customer_id = ${id} order by is_default desc, created_at`.execute(
      d,
    ),
    sql<{
      id: string;
      code: string;
      status: string;
      points_spent: number;
      issued_at: Date;
      applied_at: Date | null;
      expires_at: Date | null;
      reward_name: string;
      folio: string | null;
    }>`select rr.id, rr.code, rr.status, rr.points_spent, rr.issued_at, rr.applied_at, rr.expires_at, r.name as reward_name, o.folio
         from reward_redemptions rr join rewards r on r.id = rr.reward_id left join orders o on o.id = rr.order_id
         where rr.customer_id = ${id} order by rr.issued_at desc limit 30`.execute(d),
    sql<{
      id: string;
      name: string;
      kind: string;
      points_cost: number;
      min_tier_key: string | null;
      min_rank: number | null;
    }>`
         select r.id, r.name, r.kind::text as kind, r.points_cost, r.min_tier_key, t.rank as min_rank
         from rewards r left join loyalty_tiers t on t.key = r.min_tier_key
         where r.is_active and (r.starts_at is null or r.starts_at <= now()) and (r.ends_at is null or r.ends_at >= now())
         order by r.points_cost`.execute(d),
    sql<{
      id: string;
      public_code: string;
      full_name: string;
      phone: string | null;
      email: string | null;
      total_orders: number;
      points_balance: number;
      last_purchase_at: Date | null;
      reasons: string[];
    }>`select * from customer_duplicates(${id})`.execute(d),
    sql<{ id: string; public_code: string; full_name: string; created_at: Date }>`
         select id, public_code, full_name, created_at from customers where merged_into_id = ${id} order by created_at`.execute(
      d,
    ),
    sql<{
      code: string;
      name: string | null;
      discount_cents: number;
      created_at: Date;
      folio: string | null;
    }>`
         select cp.code::text as code, cp.name, cr.discount_cents, cr.created_at, o.folio
         from coupon_redemptions cr join coupons cp on cp.id = cr.coupon_id left join orders o on o.id = cr.order_id
         where cr.customer_id = ${id} order by cr.created_at desc limit 20`.execute(d),
  ]);
  return {
    ledger: ledger.rows,
    orders: orders.rows,
    favorites: favorites.rows,
    events: events.rows,
    addresses: addresses.rows,
    redemptions: redemptions.rows,
    rewards: rewards.rows,
    duplicates: duplicates.rows,
    mergedFrom: mergedFrom.rows,
    coupons: coupons.rows,
  };
}

export const EVENT_LABELS: Record<string, string> = {
  birthday: "Cumpleaños",
  anniversary: "Aniversario de alta",
  inactive_30: "30 días sin comprar",
  inactive_60: "60 días sin comprar",
  tier_up: "Subió de nivel",
  returned: "Regresó tras inactividad",
  merged: "Fusión de clientes",
  milestone_10: "10 compras",
  milestone_25: "25 compras",
  milestone_50: "50 compras",
  milestone_100: "100 compras",
};

export const TX_LABELS: Record<string, string> = {
  earn: "Compra",
  redeem: "Canje",
  adjust: "Ajuste",
  expire: "Vencimiento",
  bonus: "Bono",
  reversal: "Reversa",
};

export const CHANNEL_LABELS: Record<string, string> = {
  pos: "Mostrador",
  web: "Web",
  admin: "Admin",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  new: "Nuevo",
  confirmed: "Confirmado",
  payment_pending: "Pago pendiente",
  paid: "Pagado",
  in_production: "En producción",
  ready: "Listo",
  ready_for_pickup: "Listo para recoger",
  out_for_delivery: "En reparto",
  delivered: "Entregado",
  completed: "Completado",
  cancelled: "Cancelado",
  refunded: "Reembolsado",
};

export function tierTone(
  color: string | null | undefined,
): "green" | "amber" | "red" | "blue" | "gray" {
  return color === "green" || color === "amber" || color === "red" || color === "blue"
    ? color
    : "gray";
}
