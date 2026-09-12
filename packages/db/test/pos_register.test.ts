import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
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

type Summary = {
  status: string;
  opening_cash_cents: number;
  sales_count: number;
  voided_count: number;
  sales_total_cents: number;
  cash_cents: number;
  card_cents: number;
  transfer_cents: number;
  mercadopago_cents: number;
  refunds_cash_cents: number;
  expected_cash_cents: number;
  counted_cash_cents: number | null;
  difference_cents: number | null;
};

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

describe("register_session_summary", () => {
  it("resume ventas por método, reembolsos en efectivo y efectivo esperado en vivo", async () => {
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [30000, null]),
    );
    const cashSale = await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000, tendered_cents: 10000 }],
    });
    await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 5000 }],
    });
    await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "manual", method: "transfer", amount_cents: 2500, reference: "REF1" }],
    });
    // pago dividido: efectivo + tarjeta
    await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [
        { provider: "cash", method: "cash", amount_cents: 4000, tendered_cents: 4000 },
        { provider: "manual", method: "card_terminal", amount_cents: 5000 },
      ],
    });
    // reembolso parcial en efectivo de la primera venta
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${cashSale.order_id}`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: 1000, reason: "ajuste" }),
      ]),
    );
    const s = await callFn<Summary>(db, "register_session_summary", [session]);
    expect(s.status).toBe("open");
    expect(s.opening_cash_cents).toBe(30000);
    expect(s.sales_count).toBe(4);
    expect(s.voided_count).toBe(0);
    expect(s.sales_total_cents).toBe(9000 + 5000 + 2500 + 9000);
    expect(s.cash_cents).toBe(13000);
    expect(s.card_cents).toBe(10000);
    expect(s.transfer_cents).toBe(2500);
    expect(s.mercadopago_cents).toBe(0);
    expect(s.refunds_cash_cents).toBe(1000);
    expect(s.expected_cash_cents).toBe(30000 + 13000 - 1000);
    expect(s.counted_cash_cents).toBeNull();

    const close = await withStaff(db, staff, (trx) =>
      callFn<Record<string, number>>(trx, "close_register", [session, 42000, "todo bien"]),
    );
    expect(close.expected_cash_cents).toBe(42000);
    expect(close.difference_cents).toBe(0);
    const after = await callFn<Summary>(db, "register_session_summary", [session]);
    expect(after.status).toBe("closed");
    expect(after.counted_cash_cents).toBe(42000);
    expect(after.difference_cents).toBe(0);
  });

  it("una venta anulada cuenta como voided y no suma efectivo", async () => {
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [0, null]),
    );
    const sale = await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [sale.sale_id, "error"]));
    const s = await callFn<Summary>(db, "register_session_summary", [session]);
    expect(s.sales_count).toBe(0);
    expect(s.voided_count).toBe(1);
    expect(s.cash_cents).toBe(0);
    expect(s.expected_cash_cents).toBe(0);
  });

  it("devuelve null para una sesión inexistente", async () => {
    const s = await callFn<Summary | null>(db, "register_session_summary", [
      "00000000-0000-0000-0000-000000000000",
    ]);
    expect(s).toBeNull();
  });
});

describe("cancel_pending_pos_order", () => {
  async function pendingMpOrder() {
    return withStaff(db, staff, async (trx) => {
      const orderId = await callFn<string>(trx, "create_order", [
        JSON.stringify({
          channel: "pos",
          items: [{ product_id: croissant, qty: 1 }],
          idempotency_key: "mp-" + Math.random().toString(36).slice(2),
        }),
      ]);
      await callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: orderId,
          provider: "mercadopago",
          method: "mercadopago",
          amount_cents: 4500,
          status: "pending",
          external_id: "mp-order-" + Math.random().toString(36).slice(2),
        }),
      ]);
      return orderId;
    });
  }

  it("cancela el pedido y sus pagos pendientes sin tocar stock", async () => {
    const orderId = await pendingMpOrder();
    const before = await sql<{
      status: string;
    }>`select status from orders where id = ${orderId}`.execute(db);
    expect(before.rows[0]!.status).toBe("payment_pending");
    const r = await withStaff(db, staff, (trx) =>
      callFn<{ cancelled: boolean; payments_cancelled: number }>(trx, "cancel_pending_pos_order", [
        orderId,
        "cliente se fue",
      ]),
    );
    expect(r.cancelled).toBe(true);
    expect(r.payments_cancelled).toBe(1);
    const o = await sql<{
      status: string;
      cancel_reason: string;
    }>`select status, cancel_reason from orders where id = ${orderId}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "cancelled", cancel_reason: "cliente se fue" });
    const p = await sql<{
      status: string;
    }>`select status from payments where order_id = ${orderId}`.execute(db);
    expect(p.rows[0]!.status).toBe("cancelled");
    expect(await onHand(db, croissant)).toBe(20);
    // idempotente
    const again = await withStaff(db, staff, (trx) =>
      callFn<{ cancelled: boolean; already?: boolean }>(trx, "cancel_pending_pos_order", [
        orderId,
        "otra vez",
      ]),
    );
    expect(again).toMatchObject({ cancelled: true, already: true });
  });

  it("no cancela si el webhook ya confirmó el pago (venta existente)", async () => {
    const orderId = await pendingMpOrder();
    const ext = await sql<{
      external_id: string;
    }>`select external_id from payments where order_id = ${orderId}`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "apply_mercadopago_payment", [
        JSON.stringify({
          order_id: orderId,
          external_id: ext.rows[0]!.external_id,
          mp_status: "approved",
          amount_cents: 4500,
        }),
      ]),
    );
    expect(await onHand(db, croissant)).toBe(19);
    const r = await withStaff(db, staff, (trx) =>
      callFn<{ cancelled: boolean; sale_id: string | null }>(trx, "cancel_pending_pos_order", [
        orderId,
        "tarde",
      ]),
    );
    expect(r.cancelled).toBe(false);
    expect(r.sale_id).toBeTruthy();
    const o = await sql<{
      status: string;
    }>`select status from orders where id = ${orderId}`.execute(db);
    expect(o.rows[0]!.status).toBe("completed");
  });
});
