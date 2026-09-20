/**
 * Procesamiento idempotente de notificaciones de Mercado Pago.
 * Flujo `payment` (Checkout Pro): webhook_events (unique provider+external_id) → claim atómico
 * → GET /v1/payments/{id} → external_reference = orders.id → apply_mercadopago_payment (SQL) → processed.
 * Flujo `order` (Point/QR, API de Órdenes): … → GET /v1/orders/{id} → external_reference = orders.id
 * → apply_mercadopago_payment con external_id = id de la orden MP (el mismo con el que el POS registró el
 * pago `pending`), así la transición pending → paid cierra la venta y los reenvíos son idempotentes.
 * Nunca se confía en el payload: el estado se consulta a la API.
 */
import { callFn, sql, type Database } from "@pdp/db";
import {
  createLogger,
  fetchMercadoPagoOrder,
  fetchMercadoPagoPayment,
  mpOrderStatusToPaymentStatus,
  type MpOrder,
  type MpPayment,
  type MpWebhookNotification,
} from "@pdp/integrations";

const log = createLogger("webhook.mercadopago");

export const MP_PROVIDER = "mercadopago";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MpProcessDeps = {
  fetchPayment?: (paymentId: string) => Promise<MpPayment>;
  fetchOrder?: (orderId: string) => Promise<MpOrder>;
};

/** Tipos de notificación de la API de Órdenes (Point/QR). `order` es el vigente; `orders` por compatibilidad. */
const MP_ORDER_TYPES = new Set(["order", "orders"]);

/**
 * Un evento en `processing` más viejo que esto se considera huérfano (la función murió: timeout de Vercel,
 * OOM, deploy) y vuelve a ser reclamable. Debe ser mayor que `maxDuration` de la ruta (20 s) con holgura.
 */
export const MP_STALE_PROCESSING_MS = 10 * 60_000;

export type MpProcessResult =
  | { status: "processed"; detail: Record<string, unknown> }
  | { status: "ignored"; reason: string }
  | { status: "failed"; error: string };

/** Identificador único de la notificación: `${type}:${data.id}:${action|''}`. */
export function mpEventExternalId(
  n: Pick<MpWebhookNotification, "type" | "dataId" | "action">,
): string {
  return `${n.type ?? "unknown"}:${n.dataId ?? ""}:${n.action ?? ""}`;
}

/**
 * Registra la notificación. Devuelve el id del evento y si ya estaba procesada.
 * `signatureValid` null = sin secreto configurado (solo development).
 */
export async function recordMercadoPagoEvent(
  db: Database,
  n: MpWebhookNotification,
  signatureValid: boolean | null,
): Promise<{ id: string; status: string; isNew: boolean }> {
  const externalId = mpEventExternalId(n);
  const headers = {
    "x-request-id": n.xRequestId,
    "x-signature": n.xSignature ? "[present]" : null,
  };
  const payload = { body: n.body, query: n.query };
  const ins = await sql<{ id: string; status: string }>`
    insert into webhook_events(provider, external_id, event_type, payload, headers, signature_valid)
    values (${MP_PROVIDER}, ${externalId}, ${n.type}, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(headers)}::jsonb, ${signatureValid})
    on conflict (provider, external_id) do nothing
    returning id, status
  `.execute(db);
  if (ins.rows[0]) return { ...ins.rows[0], isNew: true };
  const ex = await sql<{ id: string; status: string }>`
    select id, status from webhook_events where provider = ${MP_PROVIDER} and external_id = ${externalId}
  `.execute(db);
  return { ...ex.rows[0]!, isNew: false };
}

/**
 * Procesa un evento ya registrado. Hace claim atómico (received/failed → processing, o processing huérfano
 * de más de `staleProcessingMs`); si otro proceso lo tiene, devuelve ignored. Actualiza
 * status/attempts/last_error/last_attempt_at.
 */
export async function processMercadoPagoEvent(
  db: Database,
  eventId: string,
  deps: MpProcessDeps = {},
  opts: { staleProcessingMs?: number } = {},
): Promise<MpProcessResult> {
  const staleSecs = (opts.staleProcessingMs ?? MP_STALE_PROCESSING_MS) / 1000;
  const claim = await sql<{
    id: string;
    event_type: string | null;
    payload: { body?: Record<string, unknown> | null; query?: Record<string, string> } | null;
    attempts: number;
  }>`
    update webhook_events set status = 'processing', attempts = attempts + 1, last_attempt_at = now()
    where id = ${eventId}
      and (status in ('received','failed')
           or (status = 'processing' and coalesce(last_attempt_at, received_at) < now() - make_interval(secs => ${staleSecs})))
    returning id, event_type, payload, attempts
  `.execute(db);
  const ev = claim.rows[0];
  if (!ev) return { status: "ignored", reason: "not_claimable" };

  try {
    const result = await handle(db, ev, deps);
    if (result.status === "processed") {
      await sql`update webhook_events set status = 'processed', processed_at = now(), last_error = null where id = ${eventId}`.execute(
        db,
      );
      log.info("evento procesado", { eventId, ...result.detail });
    } else if (result.status === "ignored") {
      await sql`update webhook_events set status = 'ignored', processed_at = now(), last_error = ${result.reason} where id = ${eventId}`.execute(
        db,
      );
      log.info("evento ignorado", { eventId, reason: result.reason });
    }
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update webhook_events set status = 'failed', last_error = ${message.slice(0, 2000)} where id = ${eventId}`
      .execute(db)
      .catch((err) => log.error("no se pudo marcar el evento como failed", { eventId, err }));
    log.error("evento falló", { eventId, attempts: ev.attempts, err: e });
    return { status: "failed", error: message };
  }
}

async function handle(
  db: Database,
  ev: {
    event_type: string | null;
    payload: { body?: Record<string, unknown> | null; query?: Record<string, string> } | null;
  },
  deps: MpProcessDeps,
): Promise<MpProcessResult> {
  const type = ev.event_type ?? ev.payload?.query?.type ?? ev.payload?.query?.topic ?? null;
  const body = ev.payload?.body ?? null;
  const dataId =
    ev.payload?.query?.["data.id"] ??
    ((body?.data as { id?: unknown } | undefined)?.id !== undefined
      ? String((body!.data as { id: unknown }).id)
      : null);
  if (type && MP_ORDER_TYPES.has(type)) return handleOrder(db, dataId, deps);
  if (type !== "payment") return { status: "ignored", reason: `type=${type ?? "unknown"}` };
  if (!dataId || !/^[0-9]+$/.test(dataId)) return { status: "ignored", reason: "data.id inválido" };

  const fetchPayment = deps.fetchPayment ?? fetchMercadoPagoPayment;
  const payment = await fetchPayment(dataId); // lanza → failed (reintento)

  const orderId = payment.externalReference;
  if (!orderId || !UUID_RE.test(orderId))
    return { status: "ignored", reason: "external_reference no es un pedido" };
  const order = await sql<{
    id: string;
    folio: string;
  }>`select id, folio from orders where id = ${orderId}::uuid`.execute(db);
  if (!order.rows[0]) return { status: "ignored", reason: "pedido no existe" };

  const raw = payment.raw as Record<string, unknown> | null;
  const applied = await callFn<Record<string, unknown>>(db, "apply_mercadopago_payment", [
    JSON.stringify({
      order_id: orderId,
      external_id: payment.id,
      mp_status: payment.status,
      amount_cents: payment.transactionAmountCents,
      raw: {
        status_detail: payment.statusDetail,
        payment_method_id: payment.paymentMethodId,
        payment_type_id: payment.paymentTypeId,
        date_approved: payment.dateApproved,
        currency_id: raw?.currency_id ?? null,
        live_mode: raw?.live_mode ?? null,
      },
    }),
  ]);
  return {
    status: "processed",
    detail: {
      paymentId: payment.id,
      mpStatus: payment.status,
      orderId,
      folio: order.rows[0].folio,
      applied,
    },
  };
}

/**
 * Cobro presencial (Point/QR). La orden MP se consulta a la API; su `external_reference` es el `orders.id` que
 * el POS mandó al crearla. Se aplica UNA vez por orden MP (external_id = id de la orden): el POS ya dejó un pago
 * `pending` con ese id, y apply_mercadopago_payment lo pasa a `paid` y ejecuta finalize_sale en la misma
 * transacción. Los ids de pago de la orden (`PAY01…`) quedan en metadata para conciliar con el panel de MP.
 */
async function handleOrder(
  db: Database,
  dataId: string | null,
  deps: MpProcessDeps,
): Promise<MpProcessResult> {
  if (!dataId || !/^[A-Za-z0-9_-]{1,64}$/.test(dataId))
    return { status: "ignored", reason: "data.id inválido" };
  const fetchOrder = deps.fetchOrder ?? fetchMercadoPagoOrder;
  const mpOrder = await fetchOrder(dataId); // lanza → failed (reintento)

  const orderId = mpOrder.externalReference;
  if (!orderId || !UUID_RE.test(orderId))
    return { status: "ignored", reason: "external_reference no es un pedido" };
  const order = await sql<{
    id: string;
    folio: string;
  }>`select id, folio from orders where id = ${orderId}::uuid`.execute(db);
  if (!order.rows[0]) return { status: "ignored", reason: "pedido no existe" };

  const mpStatus = mpOrderStatusToPaymentStatus(mpOrder.status);
  // Estados intermedios (created/at_terminal/action_required) no tocan la base: el POS ya tiene el pago pending.
  if (mpStatus === "pending")
    return { status: "ignored", reason: `orden en estado ${mpOrder.status}` };

  const applied = await callFn<Record<string, unknown>>(db, "apply_mercadopago_payment", [
    JSON.stringify({
      order_id: orderId,
      external_id: mpOrder.orderId,
      mp_status: mpStatus,
      amount_cents: mpOrder.totalPaidAmountCents || mpOrder.totalAmountCents,
      raw: {
        mp_order_status: mpOrder.status,
        status_detail: mpOrder.statusDetail,
        mp_order_type: mpOrder.type,
        mp_payment_ids: mpOrder.paymentIds,
      },
    }),
  ]);
  return {
    status: "processed",
    detail: {
      mpOrderId: mpOrder.orderId,
      mpOrderStatus: mpOrder.status,
      mpStatus,
      orderId,
      folio: order.rows[0].folio,
      applied,
    },
  };
}

/**
 * Reprocesa eventos pendientes (received/failed) de las últimas 48 h con backoff exponencial por intentos
 * (2^attempts minutos, tope 6 h) y máximo `maxAttempts`, más los atorados en `processing` (función muerta)
 * de más de `staleProcessingMs`. Devuelve conteos.
 */
export async function retryPendingMercadoPagoEvents(
  db: Database,
  opts: {
    limit?: number;
    maxAttempts?: number;
    deps?: MpProcessDeps;
    staleProcessingMs?: number;
  } = {},
): Promise<{ scanned: number; processed: number; ignored: number; failed: number }> {
  const limit = Math.min(opts.limit ?? 50, 50);
  const maxAttempts = opts.maxAttempts ?? 8;
  const staleSecs = (opts.staleProcessingMs ?? MP_STALE_PROCESSING_MS) / 1000;
  const rows = await sql<{ id: string }>`
    select id from webhook_events
    where provider = ${MP_PROVIDER}
      and received_at > now() - interval '48 hours'
      and attempts < ${maxAttempts}
      and (
        (status in ('received','failed')
          and (last_attempt_at is null
               or last_attempt_at < now() - least(interval '6 hours', make_interval(mins => power(2, attempts)::int))))
        or (status = 'processing'
          and coalesce(last_attempt_at, received_at) < now() - make_interval(secs => ${staleSecs}))
      )
    order by received_at
    limit ${limit}
  `.execute(db);
  const counts = { scanned: rows.rows.length, processed: 0, ignored: 0, failed: 0 };
  for (const r of rows.rows) {
    const res = await processMercadoPagoEvent(db, r.id, opts.deps, {
      staleProcessingMs: opts.staleProcessingMs,
    });
    counts[res.status]++;
  }
  return counts;
}
