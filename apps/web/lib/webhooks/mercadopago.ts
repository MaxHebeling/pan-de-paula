/**
 * Procesamiento idempotente de notificaciones de Mercado Pago.
 * Flujo: webhook_events (unique provider+external_id) → claim atómico → GET /v1/payments/{id}
 * → external_reference = orders.id → apply_mercadopago_payment (transaccional en SQL) → processed.
 * Nunca se confía en el payload: el estado del pago se consulta a la API.
 */
import { callFn, sql, type Database } from "@pdp/db";
import {
  createLogger,
  fetchMercadoPagoPayment,
  type MpPayment,
  type MpWebhookNotification,
} from "@pdp/integrations";

const log = createLogger("webhook.mercadopago");

export const MP_PROVIDER = "mercadopago";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MpProcessDeps = {
  fetchPayment?: (paymentId: string) => Promise<MpPayment>;
};

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
 * Procesa un evento ya registrado. Hace claim atómico (received/failed → processing); si otro proceso
 * lo tiene, devuelve ignored. Actualiza status/attempts/last_error/last_attempt_at.
 */
export async function processMercadoPagoEvent(
  db: Database,
  eventId: string,
  deps: MpProcessDeps = {},
): Promise<MpProcessResult> {
  const claim = await sql<{
    id: string;
    event_type: string | null;
    payload: { body?: Record<string, unknown> | null; query?: Record<string, string> } | null;
    attempts: number;
  }>`
    update webhook_events set status = 'processing', attempts = attempts + 1, last_attempt_at = now()
    where id = ${eventId} and status in ('received','failed')
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
  if (type !== "payment") return { status: "ignored", reason: `type=${type ?? "unknown"}` };
  const body = ev.payload?.body ?? null;
  const dataId =
    ev.payload?.query?.["data.id"] ??
    ((body?.data as { id?: unknown } | undefined)?.id !== undefined
      ? String((body!.data as { id: unknown }).id)
      : null);
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
 * Reprocesa eventos pendientes (received/failed) de las últimas 48 h con backoff exponencial por intentos
 * (2^attempts minutos, tope 6 h) y máximo `maxAttempts`. Devuelve conteos.
 */
export async function retryPendingMercadoPagoEvents(
  db: Database,
  opts: { limit?: number; maxAttempts?: number; deps?: MpProcessDeps } = {},
): Promise<{ scanned: number; processed: number; ignored: number; failed: number }> {
  const limit = Math.min(opts.limit ?? 50, 50);
  const maxAttempts = opts.maxAttempts ?? 8;
  const rows = await sql<{ id: string }>`
    select id from webhook_events
    where provider = ${MP_PROVIDER}
      and status in ('received','failed')
      and received_at > now() - interval '48 hours'
      and attempts < ${maxAttempts}
      and (last_attempt_at is null
           or last_attempt_at < now() - least(interval '6 hours', make_interval(mins => power(2, attempts)::int)))
    order by received_at
    limit ${limit}
  `.execute(db);
  const counts = { scanned: rows.rows.length, processed: 0, ignored: 0, failed: 0 };
  for (const r of rows.rows) {
    const res = await processMercadoPagoEvent(db, r.id, opts.deps);
    counts[res.status]++;
  }
  return counts;
}
