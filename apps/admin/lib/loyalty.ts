import "server-only";
import { db, sql } from "./db";

export async function loyaltyProgram() {
  const [p, f] = await Promise.all([
    sql<{
      is_active: boolean;
      points_per_unit: number;
      unit_cents: number;
      min_purchase_cents: number;
      birthday_multiplier: string;
      signup_bonus_points: number;
      points_expire_days: number | null;
      rounding: "floor" | "round";
      updated_at: Date;
    }>`select is_active, points_per_unit, unit_cents, min_purchase_cents, birthday_multiplier::text, signup_bonus_points, points_expire_days, rounding, updated_at from loyalty_program where id = 1`.execute(
      db(),
    ),
    sql<{ enabled: boolean }>`select enabled from feature_flags where key = 'loyalty'`.execute(
      db(),
    ),
  ]);
  return { ...p.rows[0]!, feature_enabled: f.rows[0]?.enabled ?? false };
}

export async function rewardsList() {
  const r = await sql<{
    id: string;
    name: string;
    description: string | null;
    kind: string;
    points_cost: number;
    value_bps: number | null;
    value_cents: number | null;
    product_id: string | null;
    product_name: string | null;
    min_tier_key: string | null;
    is_active: boolean;
    starts_at: Date | null;
    ends_at: Date | null;
    redemptions: number;
  }>`select r.id, r.name, r.description, r.kind::text as kind, r.points_cost, r.value_bps, r.value_cents, r.product_id, p.name as product_name,
            r.min_tier_key, r.is_active, r.starts_at, r.ends_at,
            (select count(*) from reward_redemptions x where x.reward_id = r.id and x.status <> 'cancelled')::int as redemptions
     from rewards r left join products p on p.id = r.product_id
     order by r.is_active desc, r.points_cost`.execute(db());
  return r.rows;
}

export async function productBonuses() {
  const r = await sql<{
    product_id: string;
    name: string;
    bonus_points: number;
    is_active: boolean;
  }>`
    select b.product_id, p.name, b.bonus_points, b.is_active
    from loyalty_product_bonuses b join products p on p.id = b.product_id where p.deleted_at is null order by p.name`.execute(
    db(),
  );
  return r.rows;
}

export async function activeProducts() {
  const r = await sql<{ id: string; name: string }>`
    select id, name from products where deleted_at is null and is_active and parent_id is null order by name`.execute(
    db(),
  );
  return r.rows;
}

export async function redemptionsList(limit = 100) {
  const r = await sql<{
    id: string;
    code: string;
    status: string;
    points_spent: number;
    issued_at: Date;
    applied_at: Date | null;
    expires_at: Date | null;
    reward_name: string;
    customer_id: string;
    customer_name: string;
    public_code: string;
    folio: string | null;
    staff_name: string | null;
  }>`select rr.id, rr.code, rr.status, rr.points_spent, rr.issued_at, rr.applied_at, rr.expires_at, r.name as reward_name,
            c.id as customer_id, c.full_name as customer_name, c.public_code, o.folio, su.full_name as staff_name
     from reward_redemptions rr
     join rewards r on r.id = rr.reward_id
     join customers c on c.id = rr.customer_id
     left join orders o on o.id = rr.order_id
     left join staff_users su on su.id = rr.staff_id
     order by rr.issued_at desc limit ${limit}`.execute(db());
  return r.rows;
}

export async function loyaltyDashboard() {
  const d = db();
  const [months, tiers, birthdays, totals] = await Promise.all([
    sql<{ month: string; issued: number; redeemed: number; adjusted: number; customers: number }>`
      with bs as (select timezone as tz from business_settings where id = 1),
      m as (select generate_series(date_trunc('month', (now() at time zone (select tz from bs))::date) - interval '5 months', date_trunc('month', (now() at time zone (select tz from bs))::date), interval '1 month')::date as month)
      select to_char(m.month, 'YYYY-MM') as month,
             coalesce((select sum(points) from loyalty_transactions lt, bs where lt.kind in ('earn','bonus') and date_trunc('month', lt.created_at at time zone bs.tz)::date = m.month), 0)::int as issued,
             coalesce((select -sum(points) from loyalty_transactions lt, bs where lt.kind = 'redeem' and date_trunc('month', lt.created_at at time zone bs.tz)::date = m.month), 0)::int as redeemed,
             coalesce((select sum(points) from loyalty_transactions lt, bs where lt.kind in ('adjust','reversal','expire') and date_trunc('month', lt.created_at at time zone bs.tz)::date = m.month), 0)::int as adjusted,
             coalesce((select count(distinct customer_id) from loyalty_transactions lt, bs where lt.kind = 'earn' and date_trunc('month', lt.created_at at time zone bs.tz)::date = m.month), 0)::int as customers
      from m order by m.month`.execute(d),
    sql<{
      key: string;
      name: string;
      color: string | null;
      rank: number;
      customers: number;
      points: number;
    }>`
      select t.key, t.name, t.color, t.rank,
             (select count(*) from customers c where c.tier_key = t.key and c.deleted_at is null and c.merged_into_id is null)::int as customers,
             coalesce((select sum(points_balance) from customers c where c.tier_key = t.key and c.deleted_at is null and c.merged_into_id is null), 0)::int as points
      from loyalty_tiers t order by t.rank`.execute(d),
    sql<{
      id: string;
      public_code: string;
      full_name: string;
      birthday: string;
      next_birthday: string;
      phone: string | null;
      marketing_consent: boolean;
      days: number;
    }>`
      with bs as (select (now() at time zone timezone)::date as today from business_settings where id = 1),
      x as (
        select c.id, c.public_code, c.full_name, c.birthday, c.phone::text as phone, c.marketing_consent,
               case when to_char(c.birthday, 'MM-DD') >= to_char(bs.today, 'MM-DD')
                    then date_trunc('year', bs.today)::date + (c.birthday - date_trunc('year', c.birthday)::date)
                    else (date_trunc('year', bs.today)::date + interval '1 year')::date + (c.birthday - date_trunc('year', c.birthday)::date) end as next_birthday,
               bs.today
        from customers c, bs where c.birthday is not null and c.deleted_at is null and c.merged_into_id is null)
      select id, public_code, full_name, birthday::text, next_birthday::text, phone, marketing_consent, (next_birthday - today)::int as days
      from x where next_birthday <= today + 30 order by next_birthday, full_name limit 40`.execute(
      d,
    ),
    sql<{
      outstanding: number;
      customers_with_points: number;
      redemptions_30d: number;
      issued_30d: number;
    }>`
      select coalesce(sum(points_balance), 0)::int as outstanding,
             count(*) filter (where points_balance > 0)::int as customers_with_points,
             (select count(*) from reward_redemptions where issued_at >= now() - interval '30 days' and status <> 'cancelled')::int as redemptions_30d,
             coalesce((select sum(points) from loyalty_transactions where kind in ('earn','bonus') and created_at >= now() - interval '30 days'), 0)::int as issued_30d
      from customers where deleted_at is null and merged_into_id is null`.execute(d),
  ]);
  return {
    months: months.rows,
    tiers: tiers.rows,
    birthdays: birthdays.rows,
    totals: totals.rows[0]!,
  };
}

export const REWARD_KIND_LABELS: Record<string, string> = {
  discount_pct: "Descuento %",
  discount_amount: "Descuento $",
  free_product: "Producto gratis",
  gift: "Regalo",
};
