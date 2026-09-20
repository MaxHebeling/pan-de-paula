/**
 * Integración: webhooks `order` de Mercado Pago (API de Órdenes: terminal Point y QR) contra Postgres
 * (base `${DATABASE_URL_TEST}_web`). `fetchMercadoPagoOrder` se mockea: la API no se toca.
 * Verifica que un cobro en terminal/QR cierre la venta del POS una sola vez, sin duplicar pagos.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, callFn, sql, withStaff, type Database } from "@pdp/db";
import { signMercadoPagoWebhook, type MpOrder, type MpPayment } from "@pdp/integrations";
import { webTestDatabaseUrl } from "./db-url.ts";

const SECRET = "mp-webhook-secret-de-prueba-0123456789";
const fetchOrder = vi.fn<(id: string) => Promise<MpOrder>>();
const fetchPayment = vi.fn<(id: string) => Promise<MpPayment>>();

vi.mock("@pdp/integrations", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pdp/integrations")>();
  return {
    ...mod,
    fetchMercadoPagoOrder: (id: string) => fetchOrder(id),
    fetchMercadoPagoPayment: (id: string) => fetchPayment(id),
  };
});

let db: Database;
let pool: { end: () => Promise<void> };
let POST: (req: Request) => Promise<Response>;
let retry: (typeof import("@/lib/webhooks/mercadopago"))["retryPendingMercadoPagoEvents"];
let product: string;
let staff: string;

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.APP_ENV = "development";
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ POST } = await import("../app/api/webhooks/mercadopago/route"));
  ({ retryPendingMercadoPagoEvents: retry } = await import("@/lib/webhooks/mercadopago"));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  fetchOrder.mockReset();
  fetchPayment.mockReset();
  await sql`truncate table refunds, payments, sales, order_status_history, order_items, orders, inventory_movements, inventory_levels,
    production_batches, loyalty_transactions, customers, product_prices, products, webhook_events, job_runs, notifications, domain_events, audit_logs, staff_users
    restart identity cascade`.execute(db);
  staff = (
    await sql<{
      id: string;
    }>`insert into staff_users(email, full_name, password_hash, role_key) values ('t@pdp.local','T','x','owner') returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  const slug = `concha-${Date.now()}`;
  product = (
    await sql<{
      id: string;
    }>`insert into products(name, slug, track_stock) values ('Concha', ${slug}, true) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${product}, 'all', 'regular', 3000)`.execute(
    db,
  );
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 50, null, null]));
});

/** Reproduce lo que hace POST /api/pos/payments/mercadopago: pedido POS + pago `pending` con el id de la orden MP. */
async function posPendingOrder(mpOrderId: string, kind: "point" | "qr" = "point") {
  return withStaff(db, staff, async (trx) => {
    const orderId = await callFn<string>(trx, "create_order", [
      JSON.stringify({
        channel: "pos",
        items: [{ product_id: product, qty: 2 }],
        idempotency_key: "pos-" + mpOrderId,
      }),
    ]);
    await callFn(trx, "record_payment", [
      JSON.stringify({
        order_id: orderId,
        provider: "mercadopago",
        method: "mercadopago",
        amount_cents: 6000,
        status: "pending",
        external_id: mpOrderId,
        external_status: "created",
        idempotency_key: `pos-${mpOrderId}:mp:${kind}`,
        metadata: { kind, mp_order_id: mpOrderId },
      }),
    ]);
    return orderId;
  });
}

function mpOrder(
  id: string,
  orderId: string | null,
  status = "processed",
  paidCents = 6000,
  type = "point",
): MpOrder {
  const processed = status === "processed" || status === "refunded";
  return {
    orderId: id,
    status,
    statusDetail: status === "processed" ? "accredited" : status,
    type,
    externalReference: orderId,
    totalAmountCents: 6000,
    totalPaidAmountCents: processed ? paidCents : 0,
    paymentIds: ["PAY01K22Y503EJ8JHGF64KGY1PZ2B"],
    payments: [
      {
        id: "PAY01K22Y503EJ8JHGF64KGY1PZ2B",
        status,
        statusDetail: status === "processed" ? "accredited" : status,
        paidAmountCents: processed ? paidCents : 0,
      },
    ],
    raw: {},
  };
}

function notification(
  mpOrderId: string,
  opts: { action?: string; secret?: string | null; requestId?: string } = {},
) {
  const requestId = opts.requestId ?? "req-" + mpOrderId + (opts.action ?? "");
  const ts = String(Math.floor(Date.now() / 1000));
  const url = `https://elpandepaula.mx/api/webhooks/mercadopago?data.id=${mpOrderId}&type=order`;
  const headers = new Headers({ "content-type": "application/json", "x-request-id": requestId });
  if (opts.secret !== null) {
    headers.set(
      "x-signature",
      signMercadoPagoWebhook({
        dataId: mpOrderId,
        xRequestId: requestId,
        ts,
        secret: opts.secret ?? SECRET,
      }),
    );
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: opts.action ?? "order.processed",
      api_version: "v1",
      type: "order",
      live_mode: false,
      data: { id: mpOrderId, status: "processed" },
    }),
  });
}

async function state(orderId: string) {
  const o = await sql<{
    status: string;
    payment_status: string;
    paid_cents: number;
  }>`select status, payment_status, paid_cents from orders where id = ${orderId}`.execute(db);
  const p = await sql<{
    status: string;
    external_id: string;
    external_status: string | null;
    metadata: Record<string, unknown>;
  }>`select status, external_id, external_status, metadata from payments where order_id = ${orderId}`.execute(
    db,
  );
  const s = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
  const r = await sql<{ n: number }>`select count(*)::int as n from refunds`.execute(db);
  const e = await sql<{
    status: string;
    external_id: string;
    last_error: string | null;
  }>`select status, external_id, last_error from webhook_events order by received_at`.execute(db);
  const stock = await sql<{
    on_hand: string;
  }>`select on_hand from inventory_levels where product_id = ${product}`.execute(db);
  return {
    order: o.rows[0]!,
    payments: p.rows,
    sales: s.rows[0]!.n,
    refunds: r.rows[0]!.n,
    events: e.rows,
    onHand: Number(stock.rows[0]!.on_hand),
  };
}

describe("POST /api/webhooks/mercadopago — órdenes Point/QR", () => {
  it("orden Point procesada → el pago pending pasa a paid y se cierra UNA venta; reenvío = duplicado", async () => {
    const mpId = "ORD01JYH1Z1YJN4HZ8J3Q0RB3YP6D";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockResolvedValue(mpOrder(mpId, orderId));

    const r1 = await POST(notification(mpId));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, status: "processed" });

    const r2 = await POST(notification(mpId));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, duplicate: true, status: "processed" });

    const st = await state(orderId);
    expect(st.sales).toBe(1);
    expect(st.payments).toHaveLength(1);
    expect(st.payments[0]).toMatchObject({
      status: "paid",
      external_id: mpId,
      external_status: "approved",
    });
    expect(st.payments[0]!.metadata).toMatchObject({
      mp_order_status: "processed",
      mp_payment_ids: ["PAY01K22Y503EJ8JHGF64KGY1PZ2B"],
    });
    expect(st.order).toMatchObject({ payment_status: "paid", paid_cents: 6000 });
    expect(st.onHand).toBe(48);
    expect(st.events).toEqual([
      expect.objectContaining({
        status: "processed",
        external_id: `order:${mpId}:order.processed`,
      }),
    ]);
    expect(fetchOrder).toHaveBeenCalledTimes(1);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("orden QR procesada cierra la venta igual que Point", async () => {
    const mpId = "ORD01AAAAAAAAAAAAAAAAAAAAAAAA";
    const orderId = await posPendingOrder(mpId, "qr");
    fetchOrder.mockResolvedValue(mpOrder(mpId, orderId, "processed", 6000, "qr"));
    await POST(notification(mpId));
    const st = await state(orderId);
    expect(st.sales).toBe(1);
    expect(st.payments).toHaveLength(1);
    expect(st.payments[0]).toMatchObject({ status: "paid", external_id: mpId });
  });

  it("orden fallida → pago failed, sin venta ni movimiento de stock", async () => {
    const mpId = "ORD01BBBBBBBBBBBBBBBBBBBBBBBB";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockResolvedValue(mpOrder(mpId, orderId, "failed"));
    const r = await POST(notification(mpId, { action: "order.failed" }));
    expect(await r.json()).toMatchObject({ ok: true, status: "processed" });
    const st = await state(orderId);
    expect(st.sales).toBe(0);
    expect(st.payments[0]).toMatchObject({ status: "failed", external_status: "rejected" });
    expect(st.onHand).toBe(50);
  });

  it("orden expirada/cancelada → pago cancelled; action_required → ignored sin tocar la base", async () => {
    const mpId = "ORD01CCCCCCCCCCCCCCCCCCCCCCCC";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockResolvedValueOnce(mpOrder(mpId, orderId, "action_required"));
    const r1 = await POST(notification(mpId, { action: "order.action_required" }));
    expect(await r1.json()).toMatchObject({ ok: true, status: "ignored" });
    let st = await state(orderId);
    expect(st.payments[0]).toMatchObject({ status: "pending" });

    fetchOrder.mockResolvedValueOnce(mpOrder(mpId, orderId, "expired"));
    await POST(notification(mpId, { action: "order.expired" }));
    st = await state(orderId);
    expect(st.payments[0]).toMatchObject({ status: "cancelled" });
    expect(st.sales).toBe(0);
  });

  it("reembolso desde MP (order.refunded) concilia el pago cobrado con un refund", async () => {
    const mpId = "ORD01DDDDDDDDDDDDDDDDDDDDDDDD";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockResolvedValueOnce(mpOrder(mpId, orderId, "processed"));
    await POST(notification(mpId));
    fetchOrder.mockResolvedValueOnce(mpOrder(mpId, orderId, "refunded"));
    const r = await POST(notification(mpId, { action: "order.refunded" }));
    expect(await r.json()).toMatchObject({ ok: true, status: "processed" });
    const st = await state(orderId);
    expect(st.refunds).toBe(1);
    expect(st.payments).toHaveLength(1);
    // reenvío del refund: no crea otro
    await POST(notification(mpId, { action: "order.refunded", requestId: "otro-req" }));
    expect((await state(orderId)).refunds).toBe(1);
  });

  it("firma inválida o ausente → 401; no se registra ni se consulta la API", async () => {
    const mpId = "ORD01EEEEEEEEEEEEEEEEEEEEEEEE";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockResolvedValue(mpOrder(mpId, orderId));
    expect((await POST(notification(mpId, { secret: "otro-secreto-xxxxxxxxxxxx" }))).status).toBe(
      401,
    );
    expect((await POST(notification(mpId, { secret: null }))).status).toBe(401);
    const st = await state(orderId);
    expect(st.events).toHaveLength(0);
    expect(st.payments[0]).toMatchObject({ status: "pending" });
    expect(fetchOrder).not.toHaveBeenCalled();
  });

  it("external_reference ajeno o pedido inexistente → ignored", async () => {
    fetchOrder.mockResolvedValueOnce(mpOrder("ORD01FFFF", "no-es-uuid"));
    const r1 = await POST(notification("ORD01FFFF"));
    expect(await r1.json()).toMatchObject({ status: "ignored" });
    fetchOrder.mockResolvedValueOnce(mpOrder("ORD01GGGG", "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d"));
    const r2 = await POST(notification("ORD01GGGG"));
    expect(await r2.json()).toMatchObject({ status: "ignored" });
    expect(
      (await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db)).rows[0]!.n,
    ).toBe(0);
  });

  it("error al consultar la orden → failed + 500; el cron la reintenta y cierra la venta una vez", async () => {
    const mpId = "ORD01HHHHHHHHHHHHHHHHHHHHHHHH";
    const orderId = await posPendingOrder(mpId);
    fetchOrder.mockRejectedValueOnce(new Error("MP 502"));
    const r = await POST(notification(mpId));
    expect(r.status).toBe(500);
    expect((await state(orderId)).events[0]).toMatchObject({ status: "failed" });

    fetchOrder.mockResolvedValue(mpOrder(mpId, orderId));
    await sql`update webhook_events set last_attempt_at = now() - interval '10 minutes'`.execute(
      db,
    );
    const out = await retry(db, { limit: 50 });
    expect(out).toMatchObject({ scanned: 1, processed: 1 });
    const st = await state(orderId);
    expect(st.sales).toBe(1);
    expect(st.payments[0]).toMatchObject({ status: "paid" });
  });
});
