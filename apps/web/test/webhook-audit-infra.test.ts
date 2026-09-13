/**
 * Auditoría de infraestructura (docs/audit/infra.md): webhooks y jobs end-to-end contra Postgres
 * (base `${DATABASE_URL_TEST}_web`), con las APIs externas mockeadas.
 * Mercado Pago: producción sin secreto, firmas manipuladas, concurrencia, eventos huérfanos en `processing`,
 * montos distintos, pedido cancelado, fuera de orden, tope de intentos. Instagram: adjuntos sin texto, texto
 * vacío/larguísimo/emoji, IA sin clave, eventos huérfanos. runJob: libera el lock tras fallo, registra el error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, callFn, sql, withStaff, type Database } from "@pdp/db";
import { signMercadoPagoWebhook, signMetaPayload, type MpPayment } from "@pdp/integrations";
import { webTestDatabaseUrl } from "./db-url.ts";

const SECRET = "mp-webhook-secret-de-prueba-0123456789";
const APP_SECRET = "meta-app-secret-de-prueba";
const fetchPayment = vi.fn<(id: string) => Promise<MpPayment>>();
const send = vi.fn<(i: { recipientId: string; text: string }) => Promise<{ messageId: string }>>();

vi.mock("@pdp/integrations", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@pdp/integrations")>();
  return {
    ...mod,
    fetchMercadoPagoPayment: (id: string) => fetchPayment(id),
    sendInstagramMessage: (i: { recipientId: string; text: string }) => send(i),
  };
});

type Route = { POST: (req: Request) => Promise<Response> };
let db: Database;
let pool: { end: () => Promise<void> };
let mpRoute: Route;
let igRoute: Route;
let mpLib: typeof import("@/lib/webhooks/mercadopago");
let product: string;

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.APP_ENV = "development";
  process.env.MERCADOPAGO_WEBHOOK_SECRET = SECRET;
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_VERIFY_TOKEN = "verify-token-de-prueba";
  process.env.NEXT_PUBLIC_SITE_URL = "https://elpandepaula.mx";
  delete process.env.ANTHROPIC_API_KEY;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 6 }));
  mpRoute = await import("../app/api/webhooks/mercadopago/route");
  igRoute = await import("../app/api/webhooks/instagram/route");
  mpLib = await import("@/lib/webhooks/mercadopago");
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  fetchPayment.mockReset();
  send.mockReset();
  send.mockImplementation(async () => ({ messageId: "out-" + Math.random().toString(36).slice(2) }));
  await sql`truncate table refunds, payments, sales, order_status_history, order_items, orders, inventory_movements, inventory_levels,
    production_batches, loyalty_transactions, customers, product_prices, products, webhook_events, job_runs, notifications, domain_events,
    audit_logs, staff_users, leads, instagram_messages, instagram_conversations restart identity cascade`.execute(db);
  await sql`update feature_flags set enabled = true where key = 'instagram_bot'`.execute(db);
  await sql`update feature_flags set enabled = false where key = 'instagram_ai_replies'`.execute(db);
  const staff = (
    await sql<{ id: string }>`insert into staff_users(email, full_name, password_hash, role_key) values ('t@pdp.local','T','x','owner') returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  product = (
    await sql<{ id: string }>`insert into products(name, slug, track_stock) values ('Concha', ${"concha-" + Date.now()}, true) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${product}, 'all', 'regular', 3000)`.execute(
    db,
  );
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 50, null, null]));
});

const webOrder = () =>
  callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      fulfillment_type: "scheduled_pickup",
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [{ product_id: product, qty: 4 }],
    }),
  ]);

function notification(
  paymentId: string,
  opts: {
    action?: string;
    secret?: string | null;
    requestId?: string;
    ts?: string;
    signedDataId?: string;
  } = {},
) {
  const requestId = opts.requestId ?? "req-" + paymentId;
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const url = `https://elpandepaula.mx/api/webhooks/mercadopago?data.id=${paymentId}&type=payment`;
  const headers = new Headers({ "content-type": "application/json", "x-request-id": requestId });
  if (opts.secret !== null) {
    headers.set(
      "x-signature",
      signMercadoPagoWebhook({
        dataId: opts.signedDataId ?? paymentId,
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
      type: "payment",
      action: opts.action ?? "payment.updated",
      live_mode: false,
      data: { id: paymentId },
    }),
  });
}

function payment(id: string, orderId: string | null, status = "approved", amountCents = 12000): MpPayment {
  return {
    id,
    status,
    statusDetail: status,
    transactionAmountCents: amountCents,
    externalReference: orderId,
    paymentMethodId: "visa",
    paymentTypeId: "credit_card",
    dateApproved: status === "approved" ? new Date().toISOString() : null,
    raw: { currency_id: "MXN", live_mode: false },
  };
}

const count = async (table: string, where = "true") =>
  (
    await sql<{ n: number }>`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(where)}`.execute(db)
  ).rows[0]!.n;
const events = async () =>
  (
    await sql<{ status: string; attempts: number; last_error: string | null }>`select status, attempts, last_error from webhook_events order by received_at`.execute(
      db,
    )
  ).rows;

// ── Mercado Pago ────────────────────────────────────────────────────────────
describe("webhook Mercado Pago (auditoría)", () => {
  it("producción sin MERCADOPAGO_WEBHOOK_SECRET → 500 y nada registrado (módulo fresco)", async () => {
    vi.resetModules();
    const prevEnv = process.env.APP_ENV;
    const prevSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    process.env.APP_ENV = "production";
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
    try {
      const { POST } = await import("../app/api/webhooks/mercadopago/route");
      const r = await POST(notification("2001", { secret: null }));
      expect(r.status).toBe(500);
      expect(await r.json()).toMatchObject({ error: "webhook no configurado" });
      expect(await count("webhook_events")).toBe(0);
      expect(fetchPayment).not.toHaveBeenCalled();
    } finally {
      process.env.APP_ENV = prevEnv;
      process.env.MERCADOPAGO_WEBHOOK_SECRET = prevSecret;
      vi.resetModules();
      mpRoute = await import("../app/api/webhooks/mercadopago/route");
      igRoute = await import("../app/api/webhooks/instagram/route");
      mpLib = await import("@/lib/webhooks/mercadopago");
    }
  });

  it("ts manipulado, data.id distinto al firmado o x-request-id distinto → 401 sin registrar", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("2002", orderId));
    const signed = notification("2002");
    const sig = signed.headers.get("x-signature")!;
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: { ...Object.fromEntries(signed.headers), "x-signature": sig.replace(/ts=\d+/, "ts=1700000000") },
      body: JSON.stringify({ type: "payment", action: "payment.updated", data: { id: "2002" } }),
    });
    expect((await mpRoute.POST(tampered)).status).toBe(401);
    expect((await mpRoute.POST(notification("2002", { signedDataId: "2999" }))).status).toBe(401);
    const otherRid = notification("2002");
    otherRid.headers.set("x-request-id", "otro");
    expect((await mpRoute.POST(otherRid)).status).toBe(401);
    expect(await count("webhook_events")).toBe(0);
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("dos entregas SIMULTÁNEAS del mismo evento → una venta, un pago, un evento; ambas 200", async () => {
    const orderId = await webOrder();
    fetchPayment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return payment("2003", orderId);
    });
    const [a, b] = await Promise.all([mpRoute.POST(notification("2003")), mpRoute.POST(notification("2003"))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.some((x) => x.status === "processed")).toBe(true);
    expect(bodies.some((x) => x.duplicate === true)).toBe(true);
    expect(await count("sales")).toBe(1);
    expect(await count("payments")).toBe(1);
    expect(await count("webhook_events")).toBe(1);
    expect(fetchPayment).toHaveBeenCalledTimes(1);
  });

  it("evento huérfano en processing (función muerta): reentrega lo retoma si es viejo, y el cron también; uno reciente sigue siendo duplicado", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("2004", orderId));
    // Simula una función que murió tras el claim: evento en processing sin procesar
    await mpRoute.POST(notification("2004"));
    await sql`update webhook_events set status = 'processing', processed_at = null, last_attempt_at = now()`.execute(db);
    await sql`truncate sales, payments, refunds, inventory_movements restart identity cascade`.execute(db);
    await callFn(db, "rebuild_inventory_levels", []);
    await sql`update orders set paid_cents = 0, payment_status = 'pending', status = 'new'`.execute(db);

    // reciente → duplicado (otro proceso lo está atendiendo)
    const r1 = await mpRoute.POST(notification("2004"));
    expect(await r1.json()).toMatchObject({ duplicate: true, status: "processing" });
    expect(await count("sales")).toBe(0);
    let out = await mpLib.retryPendingMercadoPagoEvents(db, { limit: 50 });
    expect(out.scanned).toBe(0);

    // viejo → el cron lo retoma y concreta la venta una sola vez
    await sql`update webhook_events set last_attempt_at = now() - interval '11 minutes'`.execute(db);
    out = await mpLib.retryPendingMercadoPagoEvents(db, { limit: 50 });
    expect(out).toMatchObject({ scanned: 1, processed: 1 });
    expect(await count("sales")).toBe(1);
    expect((await events())[0]).toMatchObject({ status: "processed", attempts: 2 });

    // y si vuelve a quedar huérfano, la reentrega directa de MP también lo retoma
    await sql`update webhook_events set status = 'processing', last_attempt_at = now() - interval '11 minutes'`.execute(db);
    const r2 = await mpRoute.POST(notification("2004"));
    expect(await r2.json()).toMatchObject({ ok: true, status: "processed" });
    expect(await count("sales")).toBe(1); // idempotente en SQL
  });

  it("monto MENOR al pedido → 200 processed, pago parcial sin venta y alerta payment_mismatch", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("2005", orderId, "approved", 5000));
    const r = await mpRoute.POST(notification("2005"));
    expect(await r.json()).toMatchObject({ ok: true, status: "processed" });
    expect(await count("sales")).toBe(0);
    const o = (
      await sql<{ payment_status: string; paid_cents: number }>`select payment_status, paid_cents from orders where id = ${orderId}`.execute(db)
    ).rows[0]!;
    expect(o).toEqual({ payment_status: "partial", paid_cents: 5000 });
    expect(await count("notifications", "kind = 'payment_mismatch' and severity = 'error'")).toBe(1);
  });

  it("monto MAYOR al pedido → venta por el total del pedido y alerta para reembolsar la diferencia", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValue(payment("2006", orderId, "approved", 15000));
    const r = await mpRoute.POST(notification("2006"));
    expect(r.status).toBe(200);
    expect(await count("sales")).toBe(1);
    const p = (await sql<{ amount_cents: number }>`select amount_cents from payments`.execute(db)).rows[0]!;
    expect(p.amount_cents).toBe(12000);
    const n = (await sql<{ body: string }>`select body from notifications where kind = 'payment_mismatch'`.execute(db)).rows[0]!;
    expect(n.body).toMatch(/\$150\.00.*Reembolsar la diferencia/);
  });

  it("pedido cancelado con pago aprobado → 200 processed (no failed ni reintentos), alerta y sin venta", async () => {
    const orderId = await webOrder();
    await callFn(db, "change_order_status", [orderId, "cancelled", "prueba"]);
    fetchPayment.mockResolvedValue(payment("2007", orderId));
    const r = await mpRoute.POST(notification("2007"));
    expect(await r.json()).toMatchObject({ ok: true, status: "processed" });
    expect((await events())[0]).toMatchObject({ status: "processed", attempts: 1 });
    expect(await count("sales")).toBe(0);
    expect(await count("payments")).toBe(0);
    expect(await count("notifications", "kind = 'payment_on_cancelled_order'")).toBe(1);
    const out = await mpLib.retryPendingMercadoPagoEvents(db, { limit: 50 });
    expect(out.scanned).toBe(0);
  });

  it("refunded llega antes que approved: pago + reembolso; approved posterior no crea segunda venta", async () => {
    const orderId = await webOrder();
    fetchPayment.mockResolvedValueOnce(payment("2008", orderId, "refunded"));
    await mpRoute.POST(notification("2008", { action: "payment.updated" }));
    expect(await count("refunds")).toBe(1);
    fetchPayment.mockResolvedValueOnce(payment("2008", orderId, "approved"));
    await mpRoute.POST(notification("2008", { action: "payment.created" }));
    expect(await count("sales")).toBe(1);
    expect(await count("payments")).toBe(1);
    expect(await count("refunds")).toBe(1);
  });

  it("tope de intentos: el cron no vuelve a tocar un evento con 8 intentos ni uno de hace más de 48 h", async () => {
    const orderId = await webOrder();
    fetchPayment.mockRejectedValue(new Error("MP 500"));
    await mpRoute.POST(notification("2009"));
    await sql`update webhook_events set attempts = 8, last_attempt_at = now() - interval '1 day'`.execute(db);
    expect((await mpLib.retryPendingMercadoPagoEvents(db, {})).scanned).toBe(0);
    await sql`update webhook_events set attempts = 3, received_at = now() - interval '49 hours', last_attempt_at = now() - interval '1 day'`.execute(db);
    expect((await mpLib.retryPendingMercadoPagoEvents(db, {})).scanned).toBe(0);
    await sql`update webhook_events set received_at = now() - interval '1 hour'`.execute(db);
    fetchPayment.mockResolvedValue(payment("2009", orderId));
    expect(await mpLib.retryPendingMercadoPagoEvents(db, {})).toMatchObject({ scanned: 1, processed: 1 });
    expect((await events())[0]).toMatchObject({ status: "processed", attempts: 4 });
  });

  it("payload inválido: sin data.id → 200 ignored sin registrar; data.id no numérico → evento ignored sin consultar MP", async () => {
    const r1 = await mpRoute.POST(
      new Request("https://elpandepaula.mx/api/webhooks/mercadopago", {
        method: "POST",
        headers: { "x-request-id": "r", "x-signature": signMercadoPagoWebhook({ dataId: null, xRequestId: "r", ts: "1", secret: SECRET }) },
        body: "no-json",
      }),
    );
    expect(await r1.json()).toMatchObject({ ok: true, ignored: true });
    expect(await count("webhook_events")).toBe(0);
    const url = "https://elpandepaula.mx/api/webhooks/mercadopago?data.id=ABC-1&type=payment";
    const r2 = await mpRoute.POST(
      new Request(url, {
        method: "POST",
        headers: { "x-request-id": "r2", "x-signature": signMercadoPagoWebhook({ dataId: "ABC-1", xRequestId: "r2", ts: "1", secret: SECRET }) },
        body: "{}",
      }),
    );
    expect(await r2.json()).toMatchObject({ ok: true, status: "ignored" });
    expect(fetchPayment).not.toHaveBeenCalled();
    expect((await events())[0]).toMatchObject({ status: "ignored", last_error: "data.id inválido" });
  });
});

// ── runJob ──────────────────────────────────────────────────────────────────
describe("runJob (auditoría)", () => {
  it("un job que falla libera el lock, registra el error y la siguiente corrida sí ejecuta", async () => {
    const { runJob } = await import("@pdp/integrations");
    const bad = await runJob(db, "audit-job", async () => {
      throw new Error("explotó");
    });
    expect(bad).toMatchObject({ status: "failed", error: "explotó" });
    const good = await runJob(db, "audit-job", async () => ({ ok: 1 }));
    expect(good.status).toBe("succeeded");
    const runs = (
      await sql<{ status: string; error: string | null }>`select status, error from job_runs where job_name = 'audit-job' order by started_at`.execute(db)
    ).rows;
    expect(runs).toEqual([
      { status: "failed", error: "explotó" },
      { status: "succeeded", error: null },
    ]);
  });

  it("un lock huérfano (running > 15 min) no bloquea la siguiente corrida y queda marcado failed", async () => {
    const { runJob } = await import("@pdp/integrations");
    await sql`insert into job_runs(job_name, status, lock_key, started_at) values ('audit-stale', 'running', 'audit-stale', now() - interval '20 minutes')`.execute(db);
    const out = await runJob(db, "audit-stale", async () => "ran");
    expect(out.status).toBe("succeeded");
    const runs = (
      await sql<{ status: string; error: string | null }>`select status, error from job_runs where job_name = 'audit-stale' order by started_at`.execute(db)
    ).rows;
    expect(runs[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/lock expirado/) });
    expect(runs[1]).toMatchObject({ status: "succeeded" });
  });
});

// ── Instagram ───────────────────────────────────────────────────────────────
function deliver(messaging: unknown[], opts: { secret?: string | null } = {}) {
  const raw = JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000000", time: Date.now(), messaging }] });
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secret !== null) headers.set("x-hub-signature-256", signMetaPayload(raw, opts.secret ?? APP_SECRET));
  return new Request("https://elpandepaula.mx/api/webhooks/instagram", { method: "POST", headers, body: raw });
}
const msg = (mid: string, message: Record<string, unknown>, sender = "9001") => ({
  sender: { id: sender },
  recipient: { id: "17841400000000000" },
  timestamp: Date.now(),
  message: { mid, ...message },
});

describe("webhook Instagram (auditoría)", () => {
  it("adjunto sin texto: se guarda con attachments, no se responde, evento processed", async () => {
    const r = await igRoute.POST(
      deliver([msg("a1", { attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] })]),
    );
    expect(await r.json()).toMatchObject({ ok: true, results: [{ status: "processed", reason: "sin texto" }] });
    expect(send).not.toHaveBeenCalled();
    const m = (
      await sql<{ text: string | null; attachments: unknown }>`select text, attachments from instagram_messages where external_mid = 'a1'`.execute(db)
    ).rows[0]!;
    expect(m.text).toBeNull();
    expect(m.attachments).toEqual([{ type: "image", url: "https://cdn/x.jpg" }]);
    expect(await count("leads")).toBe(0);
  });

  it("texto vacío o solo espacios: sin respuesta; emoji y texto larguísimo: respuesta ≤ 1000 bytes con enlace", async () => {
    await igRoute.POST(deliver([msg("b1", { text: "   " })]));
    expect(send).not.toHaveBeenCalled();
    await igRoute.POST(deliver([msg("b2", { text: "🥐🥐🥐" }), msg("b3", { text: "quiero " + "conchas ".repeat(600) })]));
    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(Buffer.byteLength(call[0].text, "utf8")).toBeLessThanOrEqual(1000);
      expect(call[0].text).toContain("https://elpandepaula.mx/");
    }
    expect(await count("webhook_events", "status = 'processed'")).toBe(3);
  });

  it("IA activada sin ANTHROPIC_API_KEY → responde por reglas (ai=false) sin fallar", async () => {
    await sql`update feature_flags set enabled = true where key = 'instagram_ai_replies'`.execute(db);
    const r = await igRoute.POST(deliver([msg("c1", { text: "hola, precio de la concha" })]));
    expect(await r.json()).toMatchObject({ ok: true, results: [{ status: "processed" }] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toMatch(/\$30/);
    const out = (
      await sql<{ auto_reply: boolean; intent: string | null }>`select auto_reply, intent from instagram_messages where direction = 'out'`.execute(db)
    ).rows[0]!;
    expect(out).toMatchObject({ auto_reply: true, intent: "price" });
  });

  it("evento huérfano en processing se retoma cuando Meta reentrega (si es viejo); reciente = duplicado", async () => {
    send.mockRejectedValueOnce(new Error("Meta 500"));
    await igRoute.POST(deliver([msg("d1", { text: "hola" })]));
    expect((await events())[0]).toMatchObject({ status: "failed" });
    await sql`update webhook_events set status = 'processing', last_attempt_at = now()`.execute(db);
    let r = await igRoute.POST(deliver([msg("d1", { text: "hola" })]));
    expect(await r.json()).toMatchObject({ results: [{ status: "ignored", reason: "duplicate" }] });
    await sql`update webhook_events set last_attempt_at = now() - interval '11 minutes'`.execute(db);
    r = await igRoute.POST(deliver([msg("d1", { text: "hola" })]));
    expect(await r.json()).toMatchObject({ results: [{ status: "processed" }] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await count("instagram_messages", "direction = 'in'")).toBe(1);
    expect(await count("instagram_messages", "direction = 'out'")).toBe(1);
  });

  it("firma válida pero cuerpo de otro objeto (page) → 200 con 0 eventos; firma sobre cuerpo alterado → 401", async () => {
    const raw = JSON.stringify({ object: "page", entry: [] });
    const ok = await igRoute.POST(
      new Request("https://elpandepaula.mx/api/webhooks/instagram", {
        method: "POST",
        headers: { "x-hub-signature-256": signMetaPayload(raw, APP_SECRET) },
        body: raw,
      }),
    );
    expect(await ok.json()).toMatchObject({ ok: true, received: 0 });
    const bad = await igRoute.POST(
      new Request("https://elpandepaula.mx/api/webhooks/instagram", {
        method: "POST",
        headers: { "x-hub-signature-256": signMetaPayload(raw, APP_SECRET) },
        body: raw + " ",
      }),
    );
    expect(bad.status).toBe(401);
  });
});
