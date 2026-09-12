import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  onHand,
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

describe("pos_checkout", () => {
  it("vende en efectivo, descuenta stock, registra venta y pago con cambio", async () => {
    const res = await posCheckout(db, staff, {
      items: [
        { product_id: croissant, qty: 2 },
        { product_id: galleta, qty: 1 },
      ],
      payments: [{ provider: "cash", method: "cash", amount_cents: 11500, tendered_cents: 20000 }],
    });
    expect(res.total_cents).toBe(11500);
    expect(res.change_cents).toBe(8500);
    expect(res.sale_id).toBeTruthy();
    expect(res.status).toBe("completed");
    expect(await onHand(db, croissant)).toBe(18);
    expect(await onHand(db, galleta)).toBe(29);
    const sale = await sql<{
      total_cents: number;
      cost_cents: number | null;
    }>`select total_cents, cost_cents from sales`.execute(db);
    expect(sale.rows[0]!.total_cents).toBe(11500);
    const events = await sql<{
      event_type: string;
    }>`select event_type from domain_events order by id`.execute(db);
    expect(events.rows.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["ORDER_CREATED", "PAYMENT_RECEIVED", "PRODUCT_SOLD", "ORDER_PAID"]),
    );
  });

  it("es idempotente por idempotency_key (no duplica venta ni stock)", async () => {
    const payload = {
      idempotency_key: "pos-abc-1",
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    };
    const a = await posCheckout(db, staff, payload);
    const b = await posCheckout(db, staff, payload);
    expect(b.duplicate).toBe(true);
    expect(b.order_id).toBe(a.order_id);
    const n = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
    expect(await onHand(db, croissant)).toBe(19);
  });

  it("rechaza pago que excede el total y no deja estado parcial", async () => {
    await expect(
      posCheckout(db, staff, {
        items: [{ product_id: croissant, qty: 1 }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 9999 }],
      }),
    ).rejects.toThrow(/excede/);
    const n = await sql<{ n: number }>`select count(*)::int as n from orders`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
    expect(await onHand(db, croissant)).toBe(20);
  });

  it("usa precio del servidor aunque el cliente mande otro", async () => {
    const res = await posCheckout(db, staff, {
      items: [{ product_id: croissant, qty: 1, unit_price_cents: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    expect(res.total_cents).toBe(4500);
  });

  it("aplica precio promocional vigente por canal", async () => {
    await sql`insert into product_prices(product_id, channel, kind, price_cents, valid_to) values (${croissant}, 'pos', 'promo', 4000, now() + interval '1 day')`.execute(
      db,
    );
    await sql`insert into product_prices(product_id, channel, kind, price_cents, valid_from, valid_to) values (${croissant}, 'pos', 'promo', 100, now() - interval '3 day', now() - interval '1 day')`.execute(
      db,
    );
    const res = await posCheckout(db, staff, {
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4000 }],
    });
    expect(res.total_cents).toBe(4000);
  });

  it("bloquea venta sin stock cuando allow_negative_stock=false", async () => {
    await sql`update business_settings set allow_negative_stock = false`.execute(db);
    await expect(
      posCheckout(db, staff, {
        items: [{ product_id: croissant, qty: 21 }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 94500 }],
      }),
    ).rejects.toThrow(/Stock insuficiente/);
    expect(await onHand(db, croissant)).toBe(20);
  });

  it("otorga puntos al cliente y actualiza estadísticas y nivel", async () => {
    const c = await createCustomer(db);
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 3 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 13500 }],
    });
    expect(res.points_earned).toBe(13); // floor(13500/1000)
    const cust = await sql<{
      points_balance: number;
      total_orders: number;
      total_spent_cents: number;
      tier_key: string;
    }>`select points_balance, total_orders, total_spent_cents, tier_key from customers where id = ${c.customer_id}`.execute(
      db,
    );
    expect(cust.rows[0]).toMatchObject({
      points_balance: 13,
      total_orders: 1,
      total_spent_cents: 13500,
      tier_key: "new",
    });
  });

  it("void_sale revierte stock, puntos y estadísticas", async () => {
    const c = await createCustomer(db);
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    await withStaff(db, staff, (trx) =>
      callFn(trx, "void_sale", [res.sale_id, "error de captura"]),
    );
    expect(await onHand(db, croissant)).toBe(20);
    const cust = await sql<{
      points_balance: number;
      total_orders: number;
    }>`select points_balance, total_orders from customers where id = ${c.customer_id}`.execute(db);
    expect(cust.rows[0]).toMatchObject({ points_balance: 0, total_orders: 0 });
    const o = await sql<{
      status: string;
      payment_status: string;
    }>`select status, payment_status from orders where id = ${res.order_id}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "cancelled", payment_status: "cancelled" });
  });

  it("reembolso parcial revierte puntos proporcionales y marca estados", async () => {
    const c = await createCustomer(db);
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 4 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 18000 }],
    });
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${res.order_id}`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({
          payment_id: pay.rows[0]!.id,
          amount_cents: 9000,
          reason: "cliente insatisfecho",
          idempotency_key: "r1",
        }),
      ]),
    );
    // idempotente
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({
          payment_id: pay.rows[0]!.id,
          amount_cents: 9000,
          reason: "dup",
          idempotency_key: "r1",
        }),
      ]),
    );
    const o = await sql<{
      refunded_cents: number;
      payment_status: string;
      status: string;
    }>`select refunded_cents, payment_status, status from orders where id = ${res.order_id}`.execute(
      db,
    );
    expect(o.rows[0]).toMatchObject({
      refunded_cents: 9000,
      payment_status: "partially_refunded",
      status: "completed",
    });
    const cust = await sql<{
      points_balance: number;
    }>`select points_balance from customers where id = ${c.customer_id}`.execute(db);
    expect(cust.rows[0]!.points_balance).toBe(9); // 18 - floor(18*0.5)
    // El reembolso NO regresa stock
    expect(await onHand(db, croissant)).toBe(16);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_refund", [
          JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: 9001, reason: "x" }),
        ]),
      ),
    ).rejects.toThrow(/inválido/);
  });

  it("cupón porcentual válido descuenta y registra uso; segundo uso por cliente falla", async () => {
    const c = await createCustomer(db);
    await sql`insert into coupons(code, kind, value_bps, max_uses_per_customer) values ('HOLA10', 'pct', 1000, 1)`.execute(
      db,
    );
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      coupon_code: "hola10",
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 8100 }],
    });
    expect(res.total_cents).toBe(8100);
    const uses = await sql<{ uses_count: number }>`select uses_count from coupons`.execute(db);
    expect(uses.rows[0]!.uses_count).toBe(1);
    await expect(
      posCheckout(db, staff, {
        customer_id: c.customer_id,
        coupon_code: "HOLA10",
        items: [{ product_id: croissant, qty: 1 }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 4050 }],
      }),
    ).rejects.toThrow(/customer_limit/);
  });

  it("canje de recompensa: descuenta puntos, aplica en venta y no se reutiliza", async () => {
    const c = await createCustomer(db);
    await sql`update customers set points_balance = 100, lifetime_points = 100 where id = ${c.customer_id}`.execute(
      db,
    );
    const rw = await sql<{
      id: string;
    }>`insert into rewards(name, kind, points_cost, value_cents) values ('$20 de descuento', 'discount_amount', 50, 2000) returning id`.execute(
      db,
    );
    const red = await withStaff(db, staff, (trx) =>
      callFn<{ redemption_id: string }>(trx, "redeem_reward", [c.customer_id, rw.rows[0]!.id]),
    );
    const bal = await sql<{
      points_balance: number;
    }>`select points_balance from customers where id = ${c.customer_id}`.execute(db);
    expect(bal.rows[0]!.points_balance).toBe(50);
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      reward_redemption_id: red.redemption_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
    });
    expect(res.total_cents).toBe(2500);
    await expect(
      posCheckout(db, staff, {
        customer_id: c.customer_id,
        reward_redemption_id: red.redemption_id,
        items: [{ product_id: croissant, qty: 1 }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
      }),
    ).rejects.toThrow(/no disponible/);
  });

  it("pedido de $0 (recompensa cubre todo) se concreta sin pago", async () => {
    const c = await createCustomer(db);
    await sql`update customers set points_balance = 100 where id = ${c.customer_id}`.execute(db);
    const rw = await sql<{
      id: string;
    }>`insert into rewards(name, kind, points_cost, product_id) values ('Croissant gratis', 'free_product', 10, ${croissant}) returning id`.execute(
      db,
    );
    const red = await withStaff(db, staff, (trx) =>
      callFn<{ redemption_id: string }>(trx, "redeem_reward", [c.customer_id, rw.rows[0]!.id]),
    );
    const res = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      reward_redemption_id: red.redemption_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [],
    });
    expect(res.total_cents).toBe(0);
    expect(res.sale_id).toBeTruthy();
    expect(await onHand(db, croissant)).toBe(19);
  });

  it("caja: apertura única, cierre calcula efectivo esperado y diferencia", async () => {
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [50000, null]),
    );
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "open_register", [0, null])),
    ).rejects.toThrow(/Ya hay una caja/);
    await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500, tendered_cents: 5000 }],
    });
    await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 5000 }],
    });
    const close = await withStaff(db, staff, (trx) =>
      callFn<Record<string, number>>(trx, "close_register", [session, 54000, null]),
    );
    expect(close.expected_cash_cents).toBe(54500);
    expect(close.difference_cents).toBe(-500);
    expect(close.card_cents).toBe(5000);
    const notif = await sql<{
      kind: string;
    }>`select kind from notifications where kind = 'register_difference'`.execute(db);
    expect(notif.rows.length).toBe(1);
  });
});
