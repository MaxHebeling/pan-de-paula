/**
 * Mercado Pago México — adaptador REST (sin SDK).
 * Implementación completa: Checkout Pro (preferencias), consulta de pagos, firma de webhooks,
 * reembolsos, Point y QR vía API de Órdenes (`/v1/orders`).
 *
 * Referencias oficiales consultadas (2026-09):
 * - Webhooks y firma x-signature:
 *   https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks
 *   Manifest: `id:[data.id_url];request-id:[x-request-id_header];ts:[ts_header];` → HMAC-SHA256 hex con la clave secreta.
 *   Si `data.id` trae letras mayúsculas, se pasa a minúsculas; los valores ausentes se omiten del manifest.
 * - Checkout Pro / preferencias: POST https://api.mercadopago.com/checkout/preferences
 * - Pagos: GET https://api.mercadopago.com/v1/payments/{id}
 * - Reembolsos: POST https://api.mercadopago.com/v1/payments/{id}/refunds (X-Idempotency-Key)
 * - Point (API de Órdenes): https://www.mercadopago.com.mx/developers/en/reference/in-person-payments/point/orders/create-order/post
 * - QR (API de Órdenes):    https://www.mercadopago.com.mx/developers/en/reference/in-person-payments/qr-code/orders/create-order/post
 *
 * Nunca se confía en el payload del webhook: siempre se consulta GET /v1/payments/{id}.
 * Dinero: la API usa decimales en pesos; aquí todo entra y sale en centavos enteros.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NotConfiguredError } from "./errors.ts";
import { fetchWithResilience, HttpError } from "./http.ts";

export const MP_API_BASE = "https://api.mercadopago.com";

export type MpPreferenceInput = {
  orderId: string;
  folio: string;
  items: Array<{ title: string; quantity: number; unitPriceCents: number; id?: string }>;
  payer?: { name?: string; email?: string; phone?: string };
  backUrls: { success: string; failure: string; pending: string };
  notificationUrl: string;
  expiresAt?: Date;
  statementDescriptor?: string;
};
export type MpPreference = { preferenceId: string; initPoint: string; sandboxInitPoint?: string };

export type MpPayment = {
  id: string;
  status: string; // approved | pending | in_process | rejected | cancelled | refunded | charged_back | authorized | in_mediation
  statusDetail: string;
  transactionAmountCents: number;
  externalReference: string | null;
  paymentMethodId: string;
  paymentTypeId: string;
  dateApproved: string | null;
  raw: unknown;
};

export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN);
}

function assertConfigured(): string {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) throw new NotConfiguredError("Mercado Pago", ["MERCADOPAGO_ACCESS_TOKEN"]);
  return token;
}

// ── Dinero ──────────────────────────────────────────────────────────────────

/** Centavos enteros → pesos con 2 decimales como número (ej. 3050 → 30.5). */
export function centsToAmount(cents: number): number {
  if (!Number.isInteger(cents) || cents < 0)
    throw new Error(`Monto inválido en centavos: ${cents}`);
  return Number((cents / 100).toFixed(2));
}

/** Centavos enteros → string decimal "30.50" (API de Órdenes exige string). */
export function centsToAmountString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0)
    throw new Error(`Monto inválido en centavos: ${cents}`);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** Pesos (number o string decimal de la API) → centavos enteros con redondeo seguro (evita 0.1+0.2). */
export function amountToCents(amount: number | string | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new Error(`Monto inválido de Mercado Pago: ${String(amount)}`);
  // Math.round(n*100) falla con 1.005 → 100.49999; usamos corrección por epsilon y toFixed.
  const cents = Math.round(Number((n * 100).toFixed(4)));
  if (!Number.isSafeInteger(cents)) throw new Error(`Monto fuera de rango: ${String(amount)}`);
  return cents;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

type MpRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** GET y operaciones con X-Idempotency-Key son seguras de reintentar. */
  idempotent: boolean;
  timeoutMs?: number;
  /** Reintentos (default: 2 si es idempotente, 0 si no). */
  retries?: number;
};

async function mpFetch<T>(req: MpRequest): Promise<T> {
  const token = assertConfigured();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  if (req.idempotencyKey) headers["X-Idempotency-Key"] = req.idempotencyKey;
  const res = await fetchWithResilience(`${MP_API_BASE}${req.path}`, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    idempotent: req.idempotent,
    retries: req.retries ?? (req.idempotent ? 2 : 0),
    timeoutMs: req.timeoutMs ?? 10_000,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new MercadoPagoApiError(res.status, req.path, text);
  }
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new MercadoPagoApiError(res.status, req.path, `Respuesta no JSON: ${text.slice(0, 200)}`);
  }
}

export class MercadoPagoApiError extends HttpError {
  public mpMessage: string | null;
  public mpCauses: Array<{ code?: string | number; description?: string }>;
  constructor(status: number, path: string, body: string) {
    super(status, `${MP_API_BASE}${path}`, body);
    this.name = "MercadoPagoApiError";
    let parsed: {
      message?: string;
      cause?: Array<{ code?: string | number; description?: string }>;
    } = {};
    let isJson = false;
    try {
      parsed = JSON.parse(body);
      isJson = parsed !== null && typeof parsed === "object";
    } catch {
      parsed = {};
    }
    this.mpMessage = (isJson && parsed.message) || null;
    this.mpCauses = isJson && Array.isArray(parsed.cause) ? parsed.cause : [];
    // Sin JSON (HTML de mantenimiento, proxy, cuerpo vacío) se conserva un extracto del cuerpo para diagnosticar.
    const detail = this.mpMessage ?? (!isJson && body ? body.slice(0, 160) : null);
    this.message = `Mercado Pago HTTP ${status} ${path}${detail ? `: ${detail}` : ""}`;
  }
}

// ── Checkout Pro ────────────────────────────────────────────────────────────

/** ISO 8601 con offset explícito (MP no acepta "Z" en expiration_date_*): 2026-09-12T18:00:00.000-07:00 → usamos UTC como +00:00. */
export function toMpDate(d: Date): string {
  return d.toISOString().replace("Z", "+00:00");
}

/**
 * Crea una preferencia de Checkout Pro. `external_reference` = orderId; `metadata` = {order_id, folio}.
 * Idempotente por `X-Idempotency-Key` (= `pref:${orderId}`), así reintentar no crea preferencias duplicadas.
 */
export async function createMercadoPagoPreference(input: MpPreferenceInput): Promise<MpPreference> {
  assertConfigured();
  if (!input.items.length) throw new Error("La preferencia necesita al menos un ítem");
  const body: Record<string, unknown> = {
    items: input.items.map((it, i) => {
      if (!Number.isInteger(it.quantity) || it.quantity <= 0)
        throw new Error(`Cantidad inválida en ítem ${i + 1}`);
      return {
        id: it.id ?? `item-${i + 1}`,
        title: it.title.slice(0, 256),
        quantity: it.quantity,
        unit_price: centsToAmount(it.unitPriceCents),
        currency_id: "MXN",
      };
    }),
    external_reference: input.orderId,
    notification_url: input.notificationUrl,
    back_urls: {
      success: input.backUrls.success,
      failure: input.backUrls.failure,
      pending: input.backUrls.pending,
    },
    auto_return: "approved",
    statement_descriptor: (input.statementDescriptor ?? "EL PAN DE PAULA").slice(0, 22),
    metadata: { order_id: input.orderId, folio: input.folio },
    binary_mode: false,
  };
  if (input.payer && (input.payer.name || input.payer.email || input.payer.phone)) {
    const payer: Record<string, unknown> = {};
    if (input.payer.name) payer.name = input.payer.name;
    if (input.payer.email) payer.email = input.payer.email;
    if (input.payer.phone) payer.phone = { number: input.payer.phone };
    body.payer = payer;
  }
  if (input.expiresAt) {
    body.expires = true;
    body.expiration_date_from = toMpDate(new Date());
    body.expiration_date_to = toMpDate(input.expiresAt);
  }
  const r = await mpFetch<{ id: string; init_point: string; sandbox_init_point?: string }>({
    method: "POST",
    path: "/checkout/preferences",
    body,
    idempotencyKey: `pref:${input.orderId}`,
    idempotent: true,
  });
  if (!r.id || !r.init_point) throw new Error("Respuesta de preferencia incompleta");
  return {
    preferenceId: String(r.id),
    initPoint: r.init_point,
    sandboxInitPoint: r.sandbox_init_point,
  };
}

// ── Pagos ───────────────────────────────────────────────────────────────────

type MpPaymentRaw = {
  id: number | string;
  status?: string;
  status_detail?: string;
  transaction_amount?: number | string;
  external_reference?: string | null;
  payment_method_id?: string;
  payment_type_id?: string;
  date_approved?: string | null;
  currency_id?: string;
};

/**
 * Presupuesto de tiempo de la consulta de pago desde el webhook: la ruta tiene `maxDuration = 20` y MP corta a
 * los 22 s. 2 intentos × 5 s + backoff ≈ 10.5 s en el peor caso; así el evento nunca queda `processing` por
 * un timeout de la función. Si la API sigue caída, el evento queda `failed` y el cron lo reintenta.
 */
export const MP_PAYMENT_FETCH_TIMEOUT_MS = 5_000;
export const MP_PAYMENT_FETCH_RETRIES = 1;

/** Consulta un pago por id (fuente de verdad del estado). */
export async function fetchMercadoPagoPayment(paymentId: string): Promise<MpPayment> {
  assertConfigured();
  if (!/^[0-9]+$/.test(String(paymentId))) throw new Error(`ID de pago inválido: ${paymentId}`);
  const raw = await mpFetch<MpPaymentRaw>({
    method: "GET",
    path: `/v1/payments/${encodeURIComponent(String(paymentId))}`,
    idempotent: true,
    timeoutMs: MP_PAYMENT_FETCH_TIMEOUT_MS,
    retries: MP_PAYMENT_FETCH_RETRIES,
  });
  return mapPayment(raw);
}

export function mapPayment(raw: MpPaymentRaw): MpPayment {
  return {
    id: String(raw.id),
    status: String(raw.status ?? "unknown").toLowerCase(),
    statusDetail: String(raw.status_detail ?? ""),
    transactionAmountCents: amountToCents(raw.transaction_amount),
    externalReference: raw.external_reference ?? null,
    paymentMethodId: String(raw.payment_method_id ?? ""),
    paymentTypeId: String(raw.payment_type_id ?? ""),
    dateApproved: raw.date_approved ?? null,
    raw,
  };
}

// ── Webhook: firma ──────────────────────────────────────────────────────────

/** Separa `ts=…,v1=…`. Devuelve null si falta alguno. */
export function parseMercadoPagoSignatureHeader(
  header: string | null,
): { ts: string; v1: string } | null {
  if (!header) return null;
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "v1") v1 = v;
  }
  if (!ts || !v1) return null;
  if (!/^[0-9]+$/.test(ts) || !/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { ts, v1: v1.toLowerCase() };
}

/** Construye el manifest oficial. Valores ausentes se omiten (según doc). data.id alfanumérico en minúsculas. */
export function buildMercadoPagoManifest(params: {
  dataId: string | null;
  xRequestId: string | null;
  ts: string;
}): string {
  let m = "";
  if (params.dataId) {
    const id = params.dataId;
    m += `id:${/^[0-9]+$/.test(id) ? id : id.toLowerCase()};`;
  }
  if (params.xRequestId) m += `request-id:${params.xRequestId};`;
  m += `ts:${params.ts};`;
  return m;
}

/** Tolerancia de antigüedad del `ts` (ms). MP reintenta cada 15 min; damos margen amplio pero acotado. */
export const MP_SIGNATURE_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * Verifica la firma x-signature del webhook (HMAC-SHA256 sobre "id:{data.id};request-id:{x-request-id};ts:{ts};").
 * Devuelve false si falta secreto, cabeceras o la firma no coincide. Comparación en tiempo constante.
 */
export function verifyMercadoPagoSignature(params: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string | undefined;
  /** Opcional: rechaza firmas cuyo ts esté fuera de ventana (por defecto no se aplica para no romper reintentos tardíos). */
  maxAgeMs?: number;
  now?: number;
}): boolean {
  if (!params.secret) return false;
  const parsed = parseMercadoPagoSignatureHeader(params.xSignature);
  if (!parsed) return false;
  if (params.maxAgeMs !== undefined) {
    const tsMs = Number(parsed.ts) * (parsed.ts.length > 10 ? 1 : 1000);
    const now = params.now ?? Date.now();
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > params.maxAgeMs) return false;
  }
  const manifest = buildMercadoPagoManifest({
    dataId: params.dataId,
    xRequestId: params.xRequestId,
    ts: parsed.ts,
  });
  const expected = createHmac("sha256", params.secret).update(manifest).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.v1, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Solo para tests/fixtures: genera una cabecera x-signature válida. */
export function signMercadoPagoWebhook(params: {
  dataId: string | null;
  xRequestId: string | null;
  ts: string;
  secret: string;
}): string {
  const manifest = buildMercadoPagoManifest(params);
  const v1 = createHmac("sha256", params.secret).update(manifest).digest("hex");
  return `ts=${params.ts},v1=${v1}`;
}

// ── Webhook: parseo ─────────────────────────────────────────────────────────

export type MpWebhookNotification = {
  /** `data.id` (query o body). */
  dataId: string | null;
  /** `type` (body/query) o `topic` (query, formato IPN legado). */
  type: string | null;
  /** `payment.created`, `payment.updated`, … */
  action: string | null;
  /** id de la notificación (body.id o query.id). */
  notificationId: string | null;
  liveMode: boolean | null;
  xRequestId: string | null;
  xSignature: string | null;
  body: Record<string, unknown> | null;
  query: Record<string, string>;
};

/**
 * Extrae los datos relevantes de una notificación (query + body + cabeceras). Tolera body vacío o no JSON.
 * Para verificar la firma se usa el `data.id` de la QUERY (así lo especifica la documentación); si no viene, el del body.
 */
export function parseMercadoPagoWebhook(input: {
  url: string;
  rawBody: string;
  headers: { get(name: string): string | null };
}): MpWebhookNotification {
  const u = new URL(input.url);
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  let body: Record<string, unknown> | null = null;
  if (input.rawBody && input.rawBody.trim()) {
    try {
      const parsed = JSON.parse(input.rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      body = null;
    }
  }
  const bodyData = (body?.data ?? null) as { id?: unknown } | null;
  const queryDataId = query["data.id"] ?? query["id"] ?? null;
  const bodyDataId =
    bodyData && bodyData.id !== undefined && bodyData.id !== null ? String(bodyData.id) : null;
  return {
    dataId: queryDataId ?? bodyDataId,
    type:
      (typeof body?.type === "string" ? body.type : null) ??
      query["type"] ??
      query["topic"] ??
      null,
    action: typeof body?.action === "string" ? body.action : null,
    notificationId:
      body?.id !== undefined && body?.id !== null ? String(body.id) : (query["id"] ?? null),
    liveMode: typeof body?.live_mode === "boolean" ? body.live_mode : null,
    xRequestId: input.headers.get("x-request-id"),
    xSignature: input.headers.get("x-signature"),
    body,
    query,
  };
}

// ── Reembolsos ──────────────────────────────────────────────────────────────

/** Reembolso total (sin monto) o parcial de un pago. Idempotente por X-Idempotency-Key (por defecto uno aleatorio). */
export async function refundMercadoPagoPayment(
  paymentId: string,
  amountCents?: number,
  idempotencyKey?: string,
): Promise<{ refundId: string; status: string }> {
  assertConfigured();
  if (!/^[0-9]+$/.test(String(paymentId))) throw new Error(`ID de pago inválido: ${paymentId}`);
  const body = amountCents !== undefined ? { amount: centsToAmount(amountCents) } : {};
  if (amountCents !== undefined && amountCents <= 0)
    throw new Error("El monto del reembolso debe ser mayor a 0");
  const r = await mpFetch<{ id: number | string; status?: string }>({
    method: "POST",
    path: `/v1/payments/${encodeURIComponent(String(paymentId))}/refunds`,
    body,
    idempotencyKey: idempotencyKey ?? randomUUID(),
    idempotent: true, // seguro por X-Idempotency-Key
  });
  return { refundId: String(r.id), status: String(r.status ?? "unknown") };
}

// ── API de Órdenes: Point y QR ──────────────────────────────────────────────

type MpOrderResponse = {
  id: string;
  status?: string;
  status_detail?: string;
  type?: string;
  external_reference?: string | null;
  total_amount?: string | number;
  total_paid_amount?: string | number;
  type_response?: { qr_data?: string };
  transactions?: {
    payments?: Array<{
      id?: string;
      status?: string;
      status_detail?: string;
      amount?: string | number;
      paid_amount?: string | number;
    }>;
  };
};

/** external_reference de Órdenes: máx. 64, letras/números/guiones. Los UUID cumplen. */
function orderExternalReference(ref: string): string {
  const clean = ref.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  if (!clean) throw new Error("external_reference vacío");
  return clean;
}

/**
 * POS: crea una orden de cobro en una terminal Point (API de Órdenes, `type: "point"`).
 * Requisitos de la cuenta (verificar en cuenta real):
 *  - Terminal Point vinculada a la cuenta y en modo de operación PDV (`PATCH /terminals` → operating_mode PDV).
 *  - `deviceId` = `id` de la terminal según `GET /terminals` (ej. `NEWLAND_N950__N950NCC303060616`).
 *  - Los pagos Point NO se procesan en sandbox con credenciales de prueba; se prueba con montos mínimos reales.
 *  - El resultado llega por webhook (topic `orders` / `point_integration_wh`) o consultando `GET /v1/orders/{id}`.
 */
export async function createPointOrder(input: {
  deviceId: string;
  amountCents: number;
  externalReference: string;
  description: string;
  /** Clave de idempotencia (por defecto una por llamada). Reusar para reintentar la misma orden. */
  idempotencyKey?: string;
  /** "no_ticket" | "seller_ticket" | "buyer_ticket" | "both"; default no_ticket. */
  printOnTerminal?: "no_ticket" | "seller_ticket" | "buyer_ticket" | "both";
  /** Duración ISO 8601 (default PT15M). */
  expirationTime?: string;
}): Promise<{ orderId: string; status: string }> {
  assertConfigured();
  if (!input.deviceId) throw new Error("Falta deviceId de la terminal Point");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error("Monto inválido");
  const body = {
    type: "point",
    external_reference: orderExternalReference(input.externalReference),
    description: input.description.slice(0, 150),
    expiration_time: input.expirationTime ?? "PT15M",
    transactions: { payments: [{ amount: centsToAmountString(input.amountCents) }] },
    config: {
      point: {
        terminal_id: input.deviceId,
        print_on_terminal: input.printOnTerminal ?? "no_ticket",
      },
    },
  };
  const r = await mpFetch<MpOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    body,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    idempotent: true,
  });
  return { orderId: String(r.id), status: String(r.status ?? "created") };
}

/**
 * POS: crea una orden QR dinámica (API de Órdenes, `type: "qr"`, `mode: "dynamic"`) para pagar desde la app de MP.
 * Requisitos de la cuenta (verificar en cuenta real):
 *  - Sucursal (store) y caja (POS) creadas con `external_pos_id` (POST /stores, POST /pos); `MERCADOPAGO_QR_EXTERNAL_POS_ID`.
 *  - La respuesta trae `type_response.qr_data` (string EMV) que se renderiza como QR en pantalla.
 *  - El resultado llega por webhook (topic `orders`) o `GET /v1/orders/{id}`.
 */
export async function createQrOrder(input: {
  amountCents: number;
  externalReference: string;
  description: string;
  items?: Array<{ title: string; quantity: number; unitPriceCents: number }>;
  /** Caja (POS) externa; por defecto `MERCADOPAGO_QR_EXTERNAL_POS_ID`. */
  externalPosId?: string;
  idempotencyKey?: string;
  expirationTime?: string;
}): Promise<{ orderId: string; qrData: string; status: string }> {
  assertConfigured();
  const externalPosId = input.externalPosId ?? process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID;
  if (!externalPosId)
    throw new NotConfiguredError("Mercado Pago QR", ["MERCADOPAGO_QR_EXTERNAL_POS_ID"]);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error("Monto inválido");
  const total = centsToAmountString(input.amountCents);
  const body: Record<string, unknown> = {
    type: "qr",
    total_amount: total,
    external_reference: orderExternalReference(input.externalReference),
    description: input.description.slice(0, 150),
    expiration_time: input.expirationTime ?? "PT15M",
    config: { qr: { external_pos_id: externalPosId, mode: "dynamic" } },
    transactions: { payments: [{ amount: total }] },
  };
  if (input.items?.length) {
    body.items = input.items.map((it, i) => ({
      title: it.title.slice(0, 256),
      unit_price: centsToAmountString(it.unitPriceCents),
      quantity: it.quantity,
      unit_measure: "unit",
      external_code: `item-${i + 1}`,
    }));
  }
  const r = await mpFetch<MpOrderResponse>({
    method: "POST",
    path: "/v1/orders",
    body,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    idempotent: true,
  });
  const qrData = r.type_response?.qr_data;
  if (!qrData) throw new Error("Mercado Pago no devolvió qr_data");
  return { orderId: String(r.id), qrData, status: String(r.status ?? "created") };
}

export type MpOrder = {
  orderId: string;
  /** created | at_terminal | action_required | processed | failed | canceled | expired | refunded */
  status: string;
  statusDetail: string;
  /** point | qr */
  type: string;
  externalReference: string | null;
  totalAmountCents: number;
  /** Monto efectivamente acreditado (`total_paid_amount`, o la suma de `paid_amount` de los pagos). */
  totalPaidAmountCents: number;
  paymentIds: string[];
  payments: Array<{ id: string; status: string; statusDetail: string; paidAmountCents: number }>;
  raw: unknown;
};

/** ids de la API de Órdenes: `ORD01…` (alfanumérico). */
const MP_ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Consulta una orden (Point/QR) por id. Fuente de verdad del cobro presencial: el webhook `order` nunca se
 * aplica con su payload. Mismo presupuesto de tiempo que la consulta de pagos (la ruta del webhook dura ≤ 20 s).
 */
export async function fetchMercadoPagoOrder(orderId: string): Promise<MpOrder> {
  assertConfigured();
  if (!MP_ORDER_ID_RE.test(String(orderId))) throw new Error(`ID de orden inválido: ${orderId}`);
  const r = await mpFetch<MpOrderResponse>({
    method: "GET",
    path: `/v1/orders/${encodeURIComponent(orderId)}`,
    idempotent: true,
    timeoutMs: MP_PAYMENT_FETCH_TIMEOUT_MS,
    retries: MP_PAYMENT_FETCH_RETRIES,
  });
  return mapOrder(r);
}

export function mapOrder(r: MpOrderResponse): MpOrder {
  const payments = (r.transactions?.payments ?? [])
    .filter((p) => p.id)
    .map((p) => ({
      id: String(p.id),
      status: String(p.status ?? "unknown").toLowerCase(),
      statusDetail: String(p.status_detail ?? ""),
      paidAmountCents: amountToCents(p.paid_amount),
    }));
  const paidSum = payments.reduce((acc, p) => acc + p.paidAmountCents, 0);
  return {
    orderId: String(r.id),
    status: String(r.status ?? "unknown").toLowerCase(),
    statusDetail: String(r.status_detail ?? ""),
    type: String(r.type ?? ""),
    externalReference: r.external_reference ?? null,
    totalAmountCents: amountToCents(r.total_amount),
    totalPaidAmountCents:
      r.total_paid_amount !== undefined &&
      r.total_paid_amount !== null &&
      r.total_paid_amount !== ""
        ? amountToCents(r.total_paid_amount)
        : paidSum,
    paymentIds: payments.map((p) => p.id),
    payments,
    raw: r,
  };
}

/**
 * Traduce el estado de una orden (API de Órdenes) al vocabulario de pagos que entiende
 * `apply_mercadopago_payment` (approved | pending | rejected | cancelled | refunded).
 * Estados desconocidos → pending (no mueve dinero).
 */
export function mpOrderStatusToPaymentStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "processed":
      return "approved";
    case "failed":
      return "rejected";
    case "canceled":
    case "cancelled":
    case "expired":
      return "cancelled";
    case "refunded":
      return "refunded";
    default:
      // created | at_terminal | action_required | processing …
      return "pending";
  }
}
