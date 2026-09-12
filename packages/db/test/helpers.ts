import { sql } from "kysely";
import { createDb, withStaff, callFn, type Database } from "../src/index.ts";
import { databaseUrl } from "../scripts/env.ts";

export function testDb() {
  return createDb({ connectionString: databaseUrl("test"), ssl: false, max: 4 });
}

export async function truncateAll(db: Database) {
  await sql`
    truncate table
      refunds, returns, receipts, payments, sales, order_status_history, order_items, orders,
      register_sessions, inventory_movements, inventory_levels, production_batches, waste_records,
      stock_count_items, stock_counts, ingredient_movements, loyalty_transactions, reward_redemptions,
      coupon_redemptions, coupons, rewards, customer_events, customer_addresses, customers,
      recipe_items, recipes, ingredient_prices, ingredients, suppliers, product_prices, product_images, products, categories,
      webhook_events, notifications, domain_events, audit_logs, leads, instagram_messages, instagram_conversations,
      loyalty_product_bonuses, staff_sessions, staff_users, import_rows, import_batches
    restart identity cascade`.execute(db);
  await sql`alter sequence customer_code_seq restart with 1`.execute(db);
  await sql`update loyalty_program set is_active = true, points_per_unit = 1, unit_cents = 1000, min_purchase_cents = 0, birthday_multiplier = 2, signup_bonus_points = 0`.execute(
    db,
  );
  await sql`update business_settings set allow_negative_stock = true, prices_include_tax = true, tax_rate_bps = 0, low_stock_threshold = 5`.execute(
    db,
  );
  await sql`update feature_flags set enabled = true where key in ('loyalty')`.execute(db);
  await sql`update feature_flags set enabled = false where key in ('ingredient_consumption')`.execute(
    db,
  );
}

export async function createStaff(db: Database, email = "test@pdp.local", role = "owner") {
  const r = await sql<{
    id: string;
  }>`insert into staff_users(email, full_name, password_hash, role_key) values (${email}, 'Test', 'x', ${role}) returning id`.execute(
    db,
  );
  return r.rows[0]!.id;
}

export async function createProduct(
  db: Database,
  name: string,
  priceCents: number,
  opts: { trackStock?: boolean; slug?: string } = {},
) {
  const slug =
    opts.slug ??
    name.toLowerCase().replace(/\s+/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
  const r = await sql<{
    id: string;
  }>`insert into products(name, slug, track_stock) values (${name}, ${slug}, ${opts.trackStock ?? true}) returning id`.execute(
    db,
  );
  const id = r.rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${id}, 'all', 'regular', ${priceCents})`.execute(
    db,
  );
  return id;
}

export async function createCustomer(db: Database, name = "Ana López", phone = "6641234567") {
  const r = await callFn<{ customer_id: string; public_code: string; qr_token: string }>(
    db,
    "register_customer",
    [JSON.stringify({ full_name: name, phone })],
  );
  return r;
}

export async function onHand(db: Database, productId: string) {
  const r = await sql<{
    on_hand: string;
  }>`select on_hand from inventory_levels where product_id = ${productId}`.execute(db);
  return Number(r.rows[0]?.on_hand ?? 0);
}

export async function posCheckout(db: Database, staffId: string, payload: Record<string, unknown>) {
  return withStaff(db, staffId, (trx) =>
    callFn<Record<string, unknown>>(trx, "pos_checkout", [JSON.stringify(payload)]),
  );
}

export { sql, withStaff, callFn };
