/**
 * Integración: webhook de Mercado Pago end-to-end contra Postgres (base `${DATABASE_URL_TEST}_web`).
 * `fetchMercadoPagoPayment` se mockea: la API no se toca. Verifica firma, idempotencia y venta única.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, callFn, sql, withStaff, type Database } from "@pdp/db";
import { signMercadoPagoWebhook, type MpPayment } from "@pdp/integrations";
import { webTestDatabaseUrl } from "./db-url.ts";

const SECRET = "mp-webhook-secret-de-prueba-0123456789";
const fetchPayment = vi.fn<(id: string) => Promise<MpPayment>>();

vi.mock("@pdp/integrations", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pdp/integrations")>();
  return { ...mod, fetchMercadoPagoPayment: (id: string) => fetchPayment(id) };
});

let db: Database;
let pool: { end: () => Promise<void> };
let POST: (req: Request) => Promise<Response>;
let GET: () => Response;
let retry: (typeof import("@/lib/webhooks/mercadopago"))["retryPendingMercadoPagoEvents"];
let product: string;

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.APP_ENV = "development";
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ POST, GET } = await import("../app/api/webhooks/mercadopago/route"));
  ({ retryPendingMercadoPagoEvents: retry } = await import("@/lib/webhooks/mercadopago"));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  fetchPayment.mockReset();
  await sql`truncate table refunds, payments, sales, order_status_history, order_items, orders, inventory_movements, inventory_levels,
    production_batches, loyalty_transactions, customers, product_prices, products, webhook_events, job_runs, notifications, domain_events, audit_logs, staff_users
    restart identity cascade`.execute(db);
  const staff = (
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

async function webOrder() {
  return callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      fulfillment_type: "scheduled_pickup",
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [{ product_id: product, qty: 4 }],
    }),
  ]);
}

function notification(
  paymentId: string,
  opts: { action?: string; secret?: string | null; requestId?: string; type?: string } = {},
) {
  const requestId = opts.requestId ?? "req-" + paymentId;
  const ts = String(Math.floor(Date.now() / 1000));
  const url = `https://elpandepaula.mx/api/webhooks/mercadopago?data.id=${paymentId}&type=${opts.type ?? "payment"}`;
  const headers = new Headers({ "content-type": "application/json", "x-request-id": requestId });
  if (opts.secret !== null) {
    headers.set(
      "x-signature",
      signMercadoPagoWebhook({
        dataId: paymentId,
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
      id: Number(paymentId) * 7,
      type: opts.type ?? "payment",
      action: opts.action ?? "payment.updated",
      live_mode: false,
      data: { id: paymentId },
    }),
  });
}

function payment(
  id: string,
  orderId: string | null,
  status = "approved",
  amountCents = 12000,
): MpPayment {
  return {
    id,
    status,
    statusDetail: status === "approved" ? "accredited" : status,
    transactionAmountCents: amountCents,
    externalReference: orderId,
    paymentMethodId: "visa",
    paymentTypeId: "credit_card",
    dateApproved: status === "approved" ? new Date().toISOString() : null,
    raw: { currency_id: "MXN", live_mode: false },
  };
}

async function counts() {
  const s = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
  const p = await sql<{ n: number }>`select count(*)::int as n from payments`.execute(db);
  const e = await sql<{
    status: string;
    attempts: number;
    external_id: string;
  }>`select status, attempts, external_id from webhook_events order by received_at`.execute(db);
  return { sales: s.rows[0]!.n, payments: p.rows[0]!.n, events: e.rows };
}

describe("POST /api/webhooks/mercadopago", () => {
  it("GET responde 200", () => {
    expect(GET().status).toBe(200);
  });

  it("dos entregas del mismo evento → una sola venta, un solo pago, un solo evento", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("1001", orderId));

    const r1 = await POST(notification("1001"));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, status: "processed" });

    const r2 = await POST(notification("1001"));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ ok: true, duplicate: true, status: "processed" });

    const c = await counts();
    expect(c.sales).toBe(1);
    expect(c.payments).toBe(1);
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({
      status: "processed",
      attempts: 1,
      external_id: "payment:1001:payment.updated",
    });
    expect(fetchPayment).toHaveBeenCalledTimes(1);

    const o = await sql<{
      status: string;
      paid_cents: number;
    }>`select status, paid_cents from orders where id = ${orderId}`.execute(db);
    expect(o.rows[0]).toMatchObject({ status: "paid", paid_cents: 12000 });
    const stock = await sql<{
      on_hand: string;
    }>`select on_hand from inventory_levels where product_id = ${product}`.execute(db);
    expect(Number(stock.rows[0]!.on_hand)).toBe(46);
  });

  it("created + updated del mismo pago son dos eventos pero un solo pago/venta (idempotencia en SQL)", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("1002", orderId));
    await POST(notification("1002", { action: "payment.created" }));
    await POST(notification("1002", { action: "payment.updated" }));
    const c = await counts();
    expect(c.events).toHaveLength(2);
    expect(c.sales).toBe(1);
    expect(c.payments).toBe(1);
  });

  it("firma inválida → 401 y no se registra nada", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("1003", orderId));
    const r = await POST(notification("1003", { secret: "otro-secreto-incorrecto-xxxxxxxx" }));
    expect(r.status).toBe(401);
    const r2 = await POST(notification("1003", { secret: null }));
    expect(r2.status).toBe(401);
    expect((await counts()).events).toHaveLength(0);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("type distinto de payment → ignored; external_reference que no es pedido → ignored", async () => {
    const r = await POST(notification("55", { type: "merchant_order" }));
    expect(await r.json()).toMatchObject({ ok: true, status: "ignored" });
    fetchPayment.mockResolvedValue(payment("1004", "no-es-uuid"));
    const r2 = await POST(notification("1004"));
    expect(await r2.json()).toMatchObject({ ok: true, status: "ignored" });
    fetchPayment.mockResolvedValue(payment("1005", "0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d"));
    const r3 = await POST(notification("1005"));
    expect(await r3.json()).toMatchObject({ ok: true, status: "ignored" });
    const c = await counts();
    expect(c.events.map((e) => e.status)).toEqual(["ignored", "ignored", "ignored"]);
    expect(c.sales).toBe(0);
  });

  it("error al consultar el pago → failed + 500; el cron lo reintenta y concreta la venta una sola vez", async () => {
    const orderId = await webOrder();
    fetchPayment.mockRejectedValueOnce(new Error("MP 502"));
    const r = await POST(notification("1006"));
    expect(r.status).toBe(500);
    let c = await counts();
    expect(c.events[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(c.sales).toBe(0);

    // backoff: recién intentado → el cron no lo toma todavía
    fetchPayment.mockResolvedValue(payment("1006", orderId));
    let out = await retry(db, { limit: 50 });
    expect(out).toMatchObject({ scanned: 0 });

    // simulamos que pasó el tiempo de backoff
    await sql`update webhook_events set last_attempt_at = now() - interval '10 minutes'`.execute(
      db,
    );
    out = await retry(db, { limit: 50 });
    expect(out).toMatchObject({ scanned: 1, processed: 1 });
    c = await counts();
    expect(c.events[0]).toMatchObject({ status: "processed", attempts: 2 });
    expect(c.sales).toBe(1);

    // la reentrega del mismo evento después del reintento sigue siendo duplicado
    const r2 = await POST(notification("1006"));
    expect(await r2.json()).toMatchObject({ duplicate: true });
    expect((await counts()).sales).toBe(1);
  });

  it("pending → approved transiciona el mismo pago (dos eventos, un pago)", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValueOnce(payment("1007", orderId, "pending"));
    await POST(notification("1007", { action: "payment.created" }));
    let o = await sql<{ status: string }>`select status from orders where id = ${orderId}`.execute(
      db,
    );
    expect(o.rows[0]!.status).toBe("payment_pending");
    fetchPayment.mockResolvedValueOnce(payment("1007", orderId, "approved"));
    await POST(notification("1007", { action: "payment.updated" }));
    o = await sql<{ status: string }>`select status from orders where id = ${orderId}`.execute(db);
    expect(o.rows[0]!.status).toBe("paid");
    expect((await counts()).payments).toBe(1);
  });

  it("job_runs registra el cron y evita concurrencia por lock", async () => {
    const { runJob } = await import("@pdp/integrations");
    const a = runJob(db, "webhooks-retry", async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true };
    });
    await new Promise((r) => setTimeout(r, 50));
    const b = await runJob(db, "webhooks-retry", async () => ({ ok: true }));
    expect(b.status).toBe("skipped");
    expect((await a).status).toBe("succeeded");
    const runs = await sql<{
      status: string;
    }>`select status from job_runs order by started_at`.execute(db);
    expect(runs.rows.map((r) => r.status).sort()).toEqual(["skipped", "succeeded"]);
  });
});
