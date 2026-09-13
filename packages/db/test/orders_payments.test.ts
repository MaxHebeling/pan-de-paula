import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  onHand,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let product: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  product = await createProduct(db, "Concha", 3000);
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 50, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("pedidos web + Mercado Pago", () => {
  async function webOrder(extra: Record<string, unknown> = {}) {
    return callFn<string>(db, "create_order", [
      JSON.stringify({
        channel: "web",
        fulfillment_type: "scheduled_pickup",
        customer_name: "Luis",
        customer_phone: "6640000000",
        items: [{ product_id: product, qty: 4 }],
        ...extra,
      }),
    ]);
  }

  it("crea pedido web con precios de servidor y estado new", async () => {
    const id = await webOrder({ idempotency_key: "web-1" });
    const again = await webOrder({ idempotency_key: "web-1" });
    expect(again).toBe(id);
    const o = await sql<{
      status: string;
      total_cents: number;
      folio: string;
    }>`select status, total_cents, folio from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "new", total_cents: 12000 });
    expect(o.rows[0]!.folio).toMatch(/^PDP-\d{4}-\d{6}$/);
    expect(await onHand(db, product)).toBe(50); // no descuenta hasta que se pague
  });

  it("webhook aprobado concreta la venta; duplicados no la repiten", async () => {
    const id = await webOrder();
    const p = { order_id: id, external_id: "mp-123", mp_status: "approved", amount_cents: 12000 };
    const a = await callFn<Record<string, unknown>>(db, "apply_mercadopago_payment", [
      JSON.stringify(p),
    ]);
    const b = await callFn<Record<string, unknown>>(db, "apply_mercadopago_payment", [
      JSON.stringify(p),
    ]);
    expect(a.sale_id).toBeTruthy();
    expect(b.duplicate).toBe(true);
    const n = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
    expect(await onHand(db, product)).toBe(46);
    const o = await sql<{
      status: string;
      payment_status: string;
    }>`select status, payment_status from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "paid", payment_status: "paid" });
  });

  it("pending → approved transiciona el mismo pago; rejected no concreta", async () => {
    const id = await webOrder();
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-9",
        mp_status: "pending",
        amount_cents: 12000,
      }),
    ]);
    let o = await sql<{
      status: string;
      paid_cents: number;
    }>`select status, paid_cents from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "payment_pending", paid_cents: 0 });
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-9",
        mp_status: "approved",
        amount_cents: 12000,
      }),
    ]);
    o = await sql<{
      status: string;
      paid_cents: number;
    }>`select status, paid_cents from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "paid", paid_cents: 12000 });
    const pays = await sql<{ n: number }>`select count(*)::int as n from payments`.execute(db);
    expect(pays.rows[0]!.n).toBe(1);

    const id2 = await webOrder();
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id2,
        external_id: "mp-10",
        mp_status: "rejected",
        amount_cents: 12000,
      }),
    ]);
    const o2 = await sql<{
      status: string;
      payment_status: string;
    }>`select status, payment_status from orders where id = ${id2}`.execute(db);
    expect(o2.rows[0]!.payment_status).toBe("pending");
    expect(o2.rows[0]!.status).toBe("new");
    const notif = await sql<{
      kind: string;
    }>`select kind from notifications where kind = 'payment_failed'`.execute(db);
    expect(notif.rows.length).toBe(1);
  });

  it("refunded desde MP genera reembolso idempotente", async () => {
    const id = await webOrder();
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-77",
        mp_status: "approved",
        amount_cents: 12000,
      }),
    ]);
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-77",
        mp_status: "refunded",
        amount_cents: 12000,
      }),
    ]);
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-77",
        mp_status: "refunded",
        amount_cents: 12000,
      }),
    ]);
    const r = await sql<{ n: number }>`select count(*)::int as n from refunds`.execute(db);
    expect(r.rows[0]!.n).toBe(1);
    const o = await sql<{
      status: string;
      payment_status: string;
      refunded_cents: number;
    }>`select status, payment_status, refunded_cents from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({
      status: "refunded",
      payment_status: "refunded",
      refunded_cents: 12000,
    });
  });

  it("transiciones de estado válidas e inválidas, con historial", async () => {
    const id = await webOrder();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "confirmed", null]),
    );
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [id, "delivered", null])),
    ).rejects.toThrow(/no permitida/);
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: id,
        external_id: "mp-1",
        mp_status: "approved",
        amount_cents: 12000,
      }),
    ]);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "in_production", null]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "ready_for_pickup", null]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "delivered", "Entregado a Luis"]),
    );
    // No se puede cancelar un pedido con venta
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [id, "cancelled", null])),
    ).rejects.toThrow();
    const h = await sql<{
      to_status: string;
    }>`select to_status from order_status_history where order_id = ${id} order by id`.execute(db);
    expect(h.rows.map((r) => r.to_status)).toEqual([
      "new",
      "confirmed",
      "paid",
      "in_production",
      "ready_for_pickup",
      "delivered",
    ]);
  });

  it("cancelar pedido sin pago libera cupón", async () => {
    await sql`insert into coupons(code, kind, value_cents) values ('MENOS20', 'amount', 2000)`.execute(
      db,
    );
    const id = await webOrder({ coupon_code: "MENOS20" });
    const o = await sql<{
      total_cents: number;
      discount_cents: number;
    }>`select total_cents, discount_cents from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ total_cents: 10000, discount_cents: 2000 });
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "cancelled", "cliente canceló"]),
    );
    const c = await sql<{ uses_count: number }>`select uses_count from coupons`.execute(db);
    expect(c.rows[0]!.uses_count).toBe(0);
  });

  it("registro de cliente deduplica por teléfono y genera código/QR opacos", async () => {
    const a = await createCustomer(db, "Ana", "664 123 4567");
    const b = await createCustomer(db, "Ana L.", "6641234567");
    expect(a.customer_id).toBe(b.customer_id);
    expect(a.public_code).toMatch(/^PDP-\d{6}$/);
    expect(a.qr_token.length).toBeGreaterThan(20);
    const found = await sql<{ id: string }>`select id from find_customer(${a.qr_token})`.execute(
      db,
    );
    expect(found.rows[0]!.id).toBe(a.customer_id);
    const byCode = await sql<{
      id: string;
    }>`select id from find_customer(${a.public_code.toLowerCase()})`.execute(db);
    expect(byCode.rows[0]!.id).toBe(a.customer_id);
    await expect(
      callFn(db, "register_customer", [JSON.stringify({ full_name: "X" })]),
    ).rejects.toThrow(/teléfono o email/);
  });

  it("producción sugerida suma pedidos comprometidos para la fecha", async () => {
    // "Mañana" en la zona horaria del negocio (no en UTC): a las 12:00 locales para no cruzar de día.
    const tz = await sql<{ date: string; ts: string }>`
      select ((now() at time zone bs.timezone)::date + 1)::text as date,
             ((((now() at time zone bs.timezone)::date + 1)::text || ' 12:00')::timestamp at time zone bs.timezone)::text as ts
      from business_settings bs where bs.id = 1`.execute(db);
    const tomorrow = tz.rows[0]!.ts;
    await webOrder({ scheduled_for: tomorrow });
    await webOrder({ scheduled_for: tomorrow, items: [{ product_id: product, qty: 6 }] });
    const date = tz.rows[0]!.date;
    const r = await sql<{
      committed_qty: string;
      suggested_qty: string;
    }>`select committed_qty, suggested_qty from suggested_production(${date}::date) where product_id = ${product}`.execute(
      db,
    );
    expect(Number(r.rows[0]!.committed_qty)).toBe(10);
  });

  it("auditoría registra cambios con el staff actual", async () => {
    await withStaff(db, staff, async (trx) => {
      await sql`update products set name = 'Concha rosa' where id = ${product}`.execute(trx);
    });
    const a = await sql<{
      staff_id: string;
      action: string;
      new_data: { name: string };
    }>`select staff_id, action, new_data from audit_logs where entity = 'products' order by id desc limit 1`.execute(
      db,
    );
    expect(a.rows[0]!.staff_id).toBe(staff);
    expect(a.rows[0]!.action).toBe("UPDATE");
    expect(a.rows[0]!.new_data.name).toBe("Concha rosa");
  });

  it("anon/authenticated no tienen acceso; pdp_app sí", async () => {
    const r = await sql<{
      anon: boolean;
      app: boolean;
    }>`select has_table_privilege('anon', 'orders', 'select') as anon, has_table_privilege('pdp_app', 'orders', 'select') as app`.execute(
      db,
    );
    expect(r.rows[0]).toEqual({ anon: false, app: true });
    const f = await sql<{
      anon: boolean;
    }>`select has_function_privilege('anon', 'pos_checkout(jsonb)', 'execute') as anon`.execute(db);
    expect(f.rows[0]!.anon).toBe(false);
    const rls = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_tables t where schemaname = 'public' and not exists (select 1 from pg_class c where c.relname = t.tablename and c.relrowsecurity)`.execute(
      db,
    );
    expect(rls.rows[0]!.n).toBe(0);
  });
});
