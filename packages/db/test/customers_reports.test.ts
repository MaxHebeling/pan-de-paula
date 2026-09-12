import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let croissant: string;
let galleta: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  croissant = await createProduct(db, "Croissant", 4500);
  galleta = await createProduct(db, "Galleta", 2500);
  await withStaff(db, staff, (trx) =>
    callFn(trx, "record_production", [croissant, 20, null, null]),
  );
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [galleta, 30, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

const today = () =>
  sql<{ d: string }>`select (now() at time zone (select timezone from business_settings where id = 1))::date::text as d`
    .execute(db)
    .then((r) => r.rows[0]!.d);

describe("merge_customers", () => {
  it("mueve pedidos/ventas, transfiere puntos por ledger, suma estadísticas y marca merged_into_id", async () => {
    const keep = await createCustomer(db, "Ana López", "6641234567");
    const dup = await createCustomer(db, "Ana Lopez", "6649876543");
    await sql`update customers set email = 'ana@example.com', birthday = '1990-05-04' where id = ${dup.customer_id}`.execute(
      db,
    );
    await posCheckout(db, staff, {
      customer_id: keep.customer_id,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    await posCheckout(db, staff, {
      customer_id: dup.customer_id,
      items: [{ product_id: galleta, qty: 4 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 10000 }],
    });
    await posCheckout(db, staff, {
      customer_id: dup.customer_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    await sql`insert into customer_addresses(customer_id, street, is_default) values (${dup.customer_id}, 'Calle 1', true)`.execute(
      db,
    );
    await sql`insert into leads(source, name, customer_id) values ('instagram', 'ana', ${dup.customer_id})`.execute(
      db,
    );

    const res = await withStaff(db, staff, (trx) =>
      callFn<Record<string, number | string>>(trx, "merge_customers", [
        keep.customer_id,
        dup.customer_id,
      ]),
    );
    expect(res.orders).toBe(2);
    expect(res.sales).toBe(2);
    expect(res.points_transferred).toBe(14); // 10 + 4
    expect(res.addresses).toBe(1);
    expect(res.leads).toBe(1);

    const k = await sql<{
      points_balance: number;
      lifetime_points: number;
      total_orders: number;
      total_spent_cents: number;
      email: string | null;
      birthday: string | null;
      merged_into_id: string | null;
      tier_key: string;
    }>`select points_balance, lifetime_points, total_orders, total_spent_cents, email, birthday::text, merged_into_id, tier_key from customers where id = ${keep.customer_id}`.execute(
      db,
    );
    expect(k.rows[0]).toMatchObject({
      points_balance: 23,
      lifetime_points: 23,
      total_orders: 3,
      total_spent_cents: 23500,
      email: "ana@example.com",
      birthday: "1990-05-04",
      merged_into_id: null,
    });
    const m = await sql<{
      points_balance: number;
      merged_into_id: string | null;
    }>`select points_balance, merged_into_id from customers where id = ${dup.customer_id}`.execute(
      db,
    );
    expect(m.rows[0]).toMatchObject({ points_balance: 0, merged_into_id: keep.customer_id });

    const sales = await sql<{
      n: number;
    }>`select count(*)::int as n from sales where customer_id = ${keep.customer_id}`.execute(db);
    expect(sales.rows[0]!.n).toBe(3);
    const ledger = await sql<{
      kind: string;
      points: number;
      balance_after: number;
    }>`select kind, points, balance_after from loyalty_transactions where customer_id = ${keep.customer_id} order by id`.execute(
      db,
    );
    expect(ledger.rows.at(-1)).toMatchObject({ kind: "adjust", points: 14, balance_after: 23 });
    // El fusionado ya no se resuelve por código/QR ni acepta otra fusión
    const found = await sql<{ id: string }>`select id from find_customer(${dup.public_code})`.execute(
      db,
    );
    expect(found.rows.length).toBe(0);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "merge_customers", [keep.customer_id, dup.customer_id]),
      ),
    ).rejects.toThrow(/ya fue fusionado/);
    const ev = await sql<{
      event_type: string;
    }>`select event_type from domain_events where event_type = 'CUSTOMER_MERGED'`.execute(db);
    expect(ev.rows.length).toBe(1);
  });

  it("rechaza fusionar consigo mismo y detecta duplicados por teléfono, email y nombre", async () => {
    const a = await createCustomer(db, "María Fernanda Ruiz", "6641112233");
    const b = await createCustomer(db, "Maria Fernanda Ruíz", "+526641112233");
    const c = await createCustomer(db, "Pedro Pérez", "6645556677");
    await sql`update customers set email = 'p@x.com' where id = ${a.customer_id}`.execute(db);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "merge_customers", [a.customer_id, a.customer_id])),
    ).rejects.toThrow(/consigo mismo/);
    const dups = await sql<{
      id: string;
      reasons: string[];
    }>`select id, reasons from customer_duplicates(${a.customer_id})`.execute(db);
    const byId = Object.fromEntries(dups.rows.map((r) => [r.id, r.reasons]));
    expect(byId[b.customer_id]).toEqual(expect.arrayContaining(["phone", "name"]));
    expect(byId[c.customer_id]).toBeUndefined();
  });
});

describe("run_customer_events (cron)", () => {
  it("crea evento y notificación de cumpleaños una sola vez por día", async () => {
    const c = await createCustomer(db, "Cumple Hoy", "6640000001");
    const d = await today();
    await sql`update customers set birthday = (${d}::date - interval '30 years')::date where id = ${c.customer_id}`.execute(
      db,
    );
    const r1 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r1.birthday).toBe(1);
    const r2 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r2.birthday).toBe(0);
    const ev = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_events where kind = 'birthday' and customer_id = ${c.customer_id}`.execute(
      db,
    );
    expect(ev.rows[0]!.n).toBe(1);
    const notif = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind = 'birthday'`.execute(db);
    expect(notif.rows[0]!.n).toBe(1);
  });

  it("marca inactividad 30/60 una vez por periodo y aniversario de alta", async () => {
    const c = await createCustomer(db, "Inactivo", "6640000002");
    await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    await sql`update customers set last_purchase_at = now() - interval '31 days' where id = ${c.customer_id}`.execute(
      db,
    );
    const r1 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r1.inactive_30).toBe(1);
    expect(r1.inactive_60).toBe(0);
    const r2 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r2.inactive_30).toBe(0);
    await sql`update customers set last_purchase_at = now() - interval '61 days' where id = ${c.customer_id}`.execute(
      db,
    );
    const r3 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r3.inactive_60).toBe(1);
    // Vuelve a comprar → nuevo periodo de inactividad se detecta de nuevo
    await sql`update customers set last_purchase_at = now() - interval '30 days' where id = ${c.customer_id}`.execute(
      db,
    );
    await sql`delete from customer_events where kind = 'inactive_30'`.execute(db);
    const r4 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r4.inactive_30).toBe(1);
    // Aniversario: alta hace 1 año exacto
    const a = await createCustomer(db, "Aniversario", "6640000003");
    await sql`update customers set created_at = now() - interval '1 year' where id = ${a.customer_id}`.execute(
      db,
    );
    const r5 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r5.anniversary).toBe(1);
    const notif = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind in ('inactive_customers','anniversary')`.execute(
      db,
    );
    expect(notif.rows[0]!.n).toBe(4);
  });
});

describe("reportes", () => {
  it("report_summary excluye anuladas, resta reembolsos y agrupa pagos por método", async () => {
    const c = await createCustomer(db);
    await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    const s2 = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 5000 }],
    });
    const voided = await posCheckout(db, staff, {
      items: [{ product_id: croissant, qty: 5 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 22500 }],
    });
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [voided.sale_id, "error"]));
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${s2.order_id}`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: 2500, reason: "x" }),
      ]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_waste", [croissant, 3, "burnt", "se quemaron"]),
    );
    const d = await today();
    const r = await callFn<{
      sales: Record<string, number>;
      refunds_cents: number;
      net_cents: number;
      customers_new: number;
      payments: Array<{ method: string; amount_cents: number; refunded_cents: number }>;
      channels: Array<{ channel: string; count: number }>;
      waste: { qty: string; count: number };
      production: { qty: string; batches: number };
      inventory_units: string;
    }>(db, "report_summary", [d, d]);
    expect(r.sales.count).toBe(2);
    expect(r.sales.gross_cents).toBe(14000);
    expect(r.refunds_cents).toBe(2500);
    expect(r.net_cents).toBe(11500);
    expect(r.customers_new).toBe(1);
    expect(r.sales.ticket_cents).toBe(7000);
    const cash = r.payments.find((p) => p.method === "cash")!;
    const card = r.payments.find((p) => p.method === "card_terminal")!;
    expect(cash.amount_cents).toBe(9000);
    expect(card).toMatchObject({ amount_cents: 5000, refunded_cents: 2500 });
    expect(r.channels).toEqual([{ channel: "pos", count: 2, revenue_cents: 14000, units: 4 }]);
    expect(Number(r.waste.qty)).toBe(3);
    expect(Number(r.production.qty)).toBe(50);
    // 20 + 30 producidos − 4 vendidos (la anulada regresó) − 3 merma
    expect(Number(r.inventory_units)).toBe(43);
  });

  it("report_products calcula producido/vendido/merma/ingresos netos de descuento; report_daily_series y report_waste", async () => {
    await sql`insert into coupons(code, kind, value_bps) values ('MITAD', 'pct', 5000)`.execute(db);
    await posCheckout(db, staff, {
      coupon_code: "MITAD",
      items: [
        { product_id: croissant, qty: 2 },
        { product_id: galleta, qty: 2 },
      ],
      payments: [{ provider: "cash", method: "cash", amount_cents: 7000 }],
    });
    await withStaff(db, staff, (trx) => callFn(trx, "record_waste", [galleta, 5, "expired", null]));
    await withStaff(db, staff, (trx) => callFn(trx, "record_waste", [galleta, 1, "tasting", null]));
    const d = await today();
    const rows = await sql<{
      product_name: string;
      produced: string;
      sold: string;
      waste: string;
      on_hand: string;
      revenue_cents: number;
      cost_cents: number | null;
      margin_bps: number | null;
    }>`select * from report_products(${d}, ${d})`.execute(db);
    const cro = rows.rows.find((r) => r.product_name === "Croissant")!;
    const gal = rows.rows.find((r) => r.product_name === "Galleta")!;
    expect(Number(cro.produced)).toBe(20);
    expect(Number(cro.sold)).toBe(2);
    expect(cro.revenue_cents).toBe(4500); // 9000 − 50%
    expect(Number(cro.on_hand)).toBe(18);
    expect(Number(gal.sold)).toBe(2);
    expect(gal.revenue_cents).toBe(2500);
    expect(Number(gal.waste)).toBe(6);
    expect(Number(gal.on_hand)).toBe(22);
    expect(cro.cost_cents).toBeNull(); // sin receta → sin costo
    const series = await sql<{
      day: string;
      sales_count: number;
      revenue_cents: number;
      waste_qty: string;
    }>`select day::text, sales_count, revenue_cents, waste_qty from report_daily_series(${d}::date - 1, ${d})`.execute(
      db,
    );
    expect(series.rows.length).toBe(2);
    expect(series.rows[1]).toMatchObject({ day: d, sales_count: 1, revenue_cents: 7000 });
    expect(Number(series.rows[1]!.waste_qty)).toBe(6);
    expect(series.rows[0]!.sales_count).toBe(0);
    const waste = await sql<{
      reason: string;
      qty: string;
    }>`select reason, qty from report_waste(${d}, ${d})`.execute(db);
    expect(waste.rows.map((w) => [w.reason, Number(w.qty)])).toEqual([
      ["expired", 5],
      ["tasting", 1],
    ]);
  });

  it("report_customers: nuevos, recurrentes, top, por nivel y puntos", async () => {
    const a = await createCustomer(db, "Ana", "6640000010");
    const b = await createCustomer(db, "Beto", "6640000011");
    for (const [cust, qty] of [
      [a.customer_id, 2],
      [a.customer_id, 1],
      [b.customer_id, 2],
    ] as const) {
      await posCheckout(db, staff, {
        customer_id: cust,
        items: [{ product_id: croissant, qty }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 4500 * qty }],
      });
    }
    await withStaff(db, staff, (trx) =>
      callFn(trx, "loyalty_post", [a.customer_id, "adjust", -3, null, null, "ajuste"]),
    );
    const d = await today();
    const r = await callFn<{
      new: number;
      buying: number;
      recurring: number;
      top: Array<{ full_name: string; spent_cents: number; sales: number }>;
      tiers: Array<{ tier_key: string; customers: number }>;
      points: { issued: number; adjusted: number };
      total_active: number;
    }>(db, "report_customers", [d, d]);
    expect(r.new).toBe(2);
    expect(r.buying).toBe(2);
    expect(r.recurring).toBe(1);
    expect(r.top[0]).toMatchObject({ full_name: "Ana", spent_cents: 13500, sales: 2 });
    expect(r.tiers.find((t) => t.tier_key === "new")!.customers).toBe(2);
    expect(r.points).toMatchObject({ issued: 22, adjusted: -3 });
    expect(r.total_active).toBe(2);
  });
});
