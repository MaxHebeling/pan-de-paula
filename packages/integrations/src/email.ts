/**
 * Email transaccional (Resend REST). Si no hay API key, se registra y no falla el flujo principal.
 * Referencia: https://resend.com/docs/api-reference/emails/send-email
 *   POST https://api.resend.com/emails · Authorization: Bearer re_… · Idempotency-Key (≤256 chars, 24 h)
 *   Body: { from, to[], subject, html, text?, reply_to?, tags? } → { id }
 * Todo texto de usuario se escapa antes de entrar al HTML.
 */
import { NotConfiguredError } from "./errors.ts";
import { fetchWithResilience } from "./http.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("email");
export const RESEND_API_URL = "https://api.resend.com/emails";

export type EmailInput = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
};
export type EmailResult = {
  sent: boolean;
  id?: string;
  skipped?: "not_configured";
  error?: string;
};

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Envía un correo por Resend. Nunca lanza por errores del proveedor: devuelve `{sent:false, error}`.
 * Con `idempotencyKey` la operación es segura de reintentar (Resend deduplica 24 h).
 */
export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  if (!EMAIL_RE.test(input.to)) return { sent: false, error: "Destinatario inválido" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey.slice(0, 256);
  const body: Record<string, unknown> = {
    from: process.env.EMAIL_FROM,
    to: [input.to],
    subject: input.subject.slice(0, 998),
    html: input.html,
  };
  if (input.text) body.text = input.text;
  if (input.replyTo) body.reply_to = input.replyTo;
  try {
    const res = await fetchWithResilience(RESEND_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      idempotent: Boolean(input.idempotencyKey),
      retries: input.idempotencyKey ? 2 : 0,
      timeoutMs: 10_000,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string; name?: string };
        if (j.message) message = `${j.name ?? "error"}: ${j.message}`;
      } catch {
        message = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      }
      log.error("resend rechazó el envío", {
        to: maskEmail(input.to),
        status: res.status,
        message,
      });
      return { sent: false, error: message };
    }
    const j = JSON.parse(text) as { id?: string };
    log.info("email enviado", { to: maskEmail(input.to), id: j.id, subject: input.subject });
    return { sent: true, id: j.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("fallo al enviar email", { to: maskEmail(input.to), err: e });
    return { sent: false, error: message };
  }
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

// ── Render helpers ──────────────────────────────────────────────────────────

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Solo permite URLs http(s) absolutas en atributos href/src. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return escapeHtml(u.toString());
  } catch {
    return null;
  }
}

const mxn = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
});
export function formatMoney(cents: number): string {
  return mxn.format((cents ?? 0) / 100);
}
export function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/\.?0+$/, "");
}
export function formatDateMx(d: Date, timeZone = "America/Tijuana"): string {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(d);
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  mercadopago: "Mercado Pago",
  card_terminal: "Tarjeta (terminal)",
  transfer: "Transferencia",
  points: "Puntos",
  other: "Otro",
};

const STATUS_LABEL: Record<string, string> = {
  new: "Recibido",
  confirmed: "Confirmado",
  payment_pending: "Pago pendiente",
  paid: "Pagado",
  in_production: "En preparación",
  ready: "Listo",
  ready_for_pickup: "Listo para recoger",
  out_for_delivery: "En camino",
  delivered: "Entregado",
  completed: "Completado",
  cancelled: "Cancelado",
  refunded: "Reembolsado",
};

const C = {
  cream: "#f7f3ec",
  ink: "#2b2622",
  ink2: "#6b625a",
  sage: "#7d8f76",
  wine: "#6e2f3a",
  line: "#e6dfd3",
};

type Brand = {
  businessName: string;
  logoUrl?: string | null;
  siteUrl?: string | null;
  footerNote?: string | null;
};

function layout(brand: Brand, title: string, inner: string, preheader = ""): string {
  const logo = safeUrl(brand.logoUrl);
  const site = safeUrl(brand.siteUrl);
  const name = escapeHtml(brand.businessName);
  return `<!doctype html>
<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.cream};font-family:Georgia,'Times New Roman',serif;color:${C.ink};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.cream};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 28px 8px;text-align:center;">
${logo ? `<img src="${logo}" alt="${name}" width="96" style="display:inline-block;max-width:96px;height:auto;border-radius:50%;">` : ""}
<div style="font-size:22px;letter-spacing:.5px;margin-top:10px;">${name}</div>
<div style="font-size:12px;color:${C.ink2};font-family:Arial,Helvetica,sans-serif;">Boulangerie · Made with love</div>
</td></tr>
<tr><td style="padding:12px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;">${inner}</td></tr>
<tr><td style="padding:16px 28px;background:${C.cream};font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.ink2};text-align:center;">
${brand.footerNote ? `<div>${escapeHtml(brand.footerNote)}</div>` : ""}
${site ? `<div style="margin-top:4px;"><a href="${site}" style="color:${C.wine};">${escapeHtml(brand.siteUrl ?? "")}</a></div>` : ""}
<div style="margin-top:4px;">Este correo se generó automáticamente; si tienes dudas responde a este mensaje.</div>
</td></tr>
</table></td></tr></table></body></html>`;
}

function itemsTable(
  items: Array<{ name: string; qty: number; unitPriceCents: number; totalCents: number }>,
): string {
  const rows = items
    .map(
      (it) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid ${C.line};">${escapeHtml(it.name)}<div style="color:${C.ink2};font-size:12px;">${formatQty(it.qty)} × ${formatMoney(it.unitPriceCents)}</div></td>
<td align="right" style="padding:8px 0;border-bottom:1px solid ${C.line};white-space:nowrap;">${formatMoney(it.totalCents)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">${rows}</table>`;
}

function totalsTable(rows: Array<[string, string, boolean?]>): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;margin-top:8px;">${rows
    .map(
      ([k, v, strong]) =>
        `<tr><td style="padding:4px 0;color:${strong ? C.ink : C.ink2};${strong ? "font-weight:bold;font-size:16px;" : ""}">${escapeHtml(k)}</td><td align="right" style="padding:4px 0;${strong ? "font-weight:bold;font-size:16px;" : ""}">${escapeHtml(v)}</td></tr>`,
    )
    .join("")}</table>`;
}

function button(href: string, label: string): string {
  const u = safeUrl(href);
  if (!u) return "";
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px auto;"><tr><td style="background:${C.wine};border-radius:8px;">
<a href="${u}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(label)}</a></td></tr></table>`;
}

// ── Comprobante ─────────────────────────────────────────────────────────────

export type ReceiptData = {
  folio: string;
  businessName: string;
  soldAt: Date;
  items: Array<{ name: string; qty: number; unitPriceCents: number; totalCents: number }>;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  /** `reference` = referencia CONTABLE capturada por el negocio (clave de rastreo, folio de terminal). */
  payments: Array<{ method: string; amountCents: number; reference?: string | null }>;
  customerName?: string | null;
  pointsEarned?: number;
  pointsBalance?: number;
  logoUrl?: string | null;
  siteUrl?: string | null;
  timezone?: string;
  taxCents?: number;
  tipCents?: number;
  deliveryFeeCents?: number;
};

/** HTML del comprobante (compartido por email, impresión y PDF). */
export function renderReceiptHtml(data: ReceiptData): string {
  const totals: Array<[string, string, boolean?]> = [["Subtotal", formatMoney(data.subtotalCents)]];
  if (data.discountCents > 0) totals.push(["Descuento", `−${formatMoney(data.discountCents)}`]);
  if (data.deliveryFeeCents) totals.push(["Envío", formatMoney(data.deliveryFeeCents)]);
  if (data.taxCents) totals.push(["IVA", formatMoney(data.taxCents)]);
  if (data.tipCents) totals.push(["Propina", formatMoney(data.tipCents)]);
  totals.push(["Total", formatMoney(data.totalCents), true]);
  const payments = data.payments
    .map(
      (p) =>
        `<tr><td style="padding:3px 0;color:${C.ink2};">${escapeHtml(METHOD_LABEL[p.method] ?? p.method)}${p.reference ? `<br><span style="font-size:12px;">ref. ${escapeHtml(p.reference)}</span>` : ""}</td><td align="right" style="padding:3px 0;">${formatMoney(p.amountCents)}</td></tr>`,
    )
    .join("");
  const points =
    data.pointsEarned !== undefined || data.pointsBalance !== undefined
      ? `<div style="margin-top:16px;padding:12px;background:${C.cream};border-radius:8px;font-size:14px;">
${data.pointsEarned !== undefined ? `<div>Puntos ganados en esta compra: <strong>${escapeHtml(data.pointsEarned)}</strong></div>` : ""}
${data.pointsBalance !== undefined ? `<div>Saldo de puntos: <strong>${escapeHtml(data.pointsBalance)}</strong></div>` : ""}
</div>`
      : "";
  const inner = `
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;margin:0 0 4px;">Comprobante de compra</h1>
<div style="color:${C.ink2};font-size:13px;">Folio <strong style="color:${C.ink};">${escapeHtml(data.folio)}</strong> · ${escapeHtml(formatDateMx(data.soldAt, data.timezone))}</div>
${data.customerName ? `<p style="margin:16px 0 4px;">Gracias por tu compra, ${escapeHtml(data.customerName)}.</p>` : `<p style="margin:16px 0 4px;">Gracias por tu compra.</p>`}
<div style="margin-top:12px;">${itemsTable(data.items)}</div>
${totalsTable(totals)}
<div style="margin-top:12px;font-size:13px;color:${C.ink2};">Pagos</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">${payments}</table>
${points}`;
  return layout(
    { businessName: data.businessName, logoUrl: data.logoUrl, siteUrl: data.siteUrl },
    `Comprobante ${data.folio}`,
    inner,
    `Comprobante ${data.folio} · ${formatMoney(data.totalCents)}`,
  );
}

export function renderReceiptText(data: ReceiptData): string {
  const lines = [
    `${data.businessName} — Comprobante ${data.folio}`,
    formatDateMx(data.soldAt, data.timezone),
    "",
    ...data.items.map((it) => `${formatQty(it.qty)} x ${it.name} — ${formatMoney(it.totalCents)}`),
    "",
    `Subtotal: ${formatMoney(data.subtotalCents)}`,
    ...(data.discountCents > 0 ? [`Descuento: -${formatMoney(data.discountCents)}`] : []),
    `Total: ${formatMoney(data.totalCents)}`,
    ...data.payments.map(
      (p) =>
        `Pago ${METHOD_LABEL[p.method] ?? p.method}: ${formatMoney(p.amountCents)}${p.reference ? ` (ref. ${p.reference})` : ""}`,
    ),
  ];
  if (data.pointsEarned !== undefined) lines.push(`Puntos ganados: ${data.pointsEarned}`);
  if (data.pointsBalance !== undefined) lines.push(`Saldo de puntos: ${data.pointsBalance}`);
  return lines.join("\n");
}

export async function sendReceiptEmail(to: string, data: ReceiptData): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  return sendEmail({
    to,
    subject: `Tu comprobante ${data.folio} · ${data.businessName}`,
    html: renderReceiptHtml(data),
    text: renderReceiptText(data),
    idempotencyKey: `receipt:${data.folio}:${to.toLowerCase()}`,
  });
}

// ── Confirmación de pedido ──────────────────────────────────────────────────

export type OrderConfirmationData = {
  folio: string;
  businessName: string;
  customerName?: string | null;
  items: Array<{ name: string; qty: number; unitPriceCents: number; totalCents: number }>;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents?: number;
  totalCents: number;
  paidCents?: number;
  paymentStatus?: string; // pending | paid | …
  fulfillmentType: "pickup" | "scheduled_pickup" | "delivery" | "preorder";
  scheduledFor?: Date | null;
  pickupPoint?: { name: string; address?: string | null; mapUrl?: string | null } | null;
  deliveryAddress?: string | null;
  /** Enlace al estado del pedido en el sitio (se muestra como botón). */
  statusUrl: string;
  /** Enlace de pago pendiente (Checkout Pro) si aplica. */
  payUrl?: string | null;
  notes?: string | null;
  logoUrl?: string | null;
  siteUrl?: string | null;
  timezone?: string;
};

const FULFILLMENT_LABEL: Record<OrderConfirmationData["fulfillmentType"], string> = {
  pickup: "Recoger en tienda",
  scheduled_pickup: "Recoger en tienda (con cita)",
  delivery: "Entrega a domicilio",
  preorder: "Pedido especial",
};

export function renderOrderConfirmationHtml(data: OrderConfirmationData): string {
  const totals: Array<[string, string, boolean?]> = [["Subtotal", formatMoney(data.subtotalCents)]];
  if (data.discountCents > 0) totals.push(["Descuento", `−${formatMoney(data.discountCents)}`]);
  if (data.deliveryFeeCents) totals.push(["Envío", formatMoney(data.deliveryFeeCents)]);
  totals.push(["Total", formatMoney(data.totalCents), true]);
  const pending = data.paymentStatus !== "paid" && data.payUrl;
  const when = data.scheduledFor ? formatDateMx(data.scheduledFor, data.timezone) : null;
  const where =
    data.fulfillmentType === "delivery"
      ? data.deliveryAddress
        ? `<div><strong>Dirección:</strong> ${escapeHtml(data.deliveryAddress)}</div>`
        : ""
      : data.pickupPoint
        ? `<div><strong>Sucursal:</strong> ${escapeHtml(data.pickupPoint.name)}${data.pickupPoint.address ? ` · ${escapeHtml(data.pickupPoint.address)}` : ""}${safeUrl(data.pickupPoint.mapUrl) ? ` · <a href="${safeUrl(data.pickupPoint.mapUrl)}" style="color:${C.wine};">Cómo llegar</a>` : ""}</div>`
        : "";
  const inner = `
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;margin:0 0 4px;">¡Recibimos tu pedido!</h1>
<div style="color:${C.ink2};font-size:13px;">Folio <strong style="color:${C.ink};">${escapeHtml(data.folio)}</strong></div>
<p style="margin:16px 0 8px;">${data.customerName ? `Hola ${escapeHtml(data.customerName)}, ` : "Hola, "}gracias por pedir en ${escapeHtml(data.businessName)}.${pending ? " Tu pedido quedará confirmado en cuanto se acredite el pago." : " Ya estamos preparando todo."}</p>
<div style="padding:12px;background:${C.cream};border-radius:8px;font-size:14px;">
<div><strong>Entrega:</strong> ${escapeHtml(FULFILLMENT_LABEL[data.fulfillmentType])}</div>
${when ? `<div><strong>Fecha:</strong> ${escapeHtml(when)}</div>` : ""}
${where}
${data.notes ? `<div><strong>Notas:</strong> ${escapeHtml(data.notes)}</div>` : ""}
</div>
<div style="margin-top:12px;">${itemsTable(data.items)}</div>
${totalsTable(totals)}
${data.paidCents !== undefined ? `<div style="font-size:13px;color:${C.ink2};margin-top:4px;">Pagado: ${formatMoney(data.paidCents)}${pending ? " · pago pendiente" : ""}</div>` : ""}
${pending ? button(data.payUrl!, "Completar pago") : ""}
${button(data.statusUrl, "Ver estado de mi pedido")}
<div style="font-size:12px;color:${C.ink2};text-align:center;">Si el botón no funciona, copia este enlace:<br><a href="${safeUrl(data.statusUrl) ?? "#"}" style="color:${C.wine};word-break:break-all;">${escapeHtml(data.statusUrl)}</a></div>`;
  return layout(
    { businessName: data.businessName, logoUrl: data.logoUrl, siteUrl: data.siteUrl },
    `Pedido ${data.folio}`,
    inner,
    `Pedido ${data.folio} recibido · ${formatMoney(data.totalCents)}`,
  );
}

export async function sendOrderConfirmationEmail(
  to: string,
  data: OrderConfirmationData,
): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  const text = [
    `${data.businessName} — Pedido ${data.folio} recibido`,
    ...data.items.map((it) => `${formatQty(it.qty)} x ${it.name} — ${formatMoney(it.totalCents)}`),
    `Total: ${formatMoney(data.totalCents)}`,
    `Estado del pedido: ${data.statusUrl}`,
    ...(data.payUrl && data.paymentStatus !== "paid" ? [`Completar pago: ${data.payUrl}`] : []),
  ].join("\n");
  return sendEmail({
    to,
    subject: `Pedido ${data.folio} recibido · ${data.businessName}`,
    html: renderOrderConfirmationHtml(data),
    text,
    idempotencyKey: `order-confirmation:${data.folio}:${to.toLowerCase()}`,
  });
}

// ── Cambio de estado ────────────────────────────────────────────────────────

export type OrderStatusData = {
  folio: string;
  businessName: string;
  customerName?: string | null;
  status: string; // order_status
  statusUrl: string;
  message?: string | null;
  scheduledFor?: Date | null;
  pickupPoint?: { name: string; address?: string | null } | null;
  logoUrl?: string | null;
  siteUrl?: string | null;
  timezone?: string;
};

const STATUS_MESSAGE: Record<string, string> = {
  confirmed: "Confirmamos tu pedido. Te avisaremos cuando esté listo.",
  paid: "Recibimos tu pago. ¡Gracias! Tu pedido ya está confirmado.",
  in_production: "Tu pedido está en el horno.",
  ready: "Tu pedido está listo.",
  ready_for_pickup: "Tu pedido está listo para recoger.",
  out_for_delivery: "Tu pedido va en camino.",
  delivered: "Tu pedido fue entregado. ¡Buen provecho!",
  completed: "Tu pedido se completó. ¡Gracias por tu preferencia!",
  cancelled: "Tu pedido fue cancelado. Si no lo esperabas, respóndenos a este correo.",
  refunded: "Tu pedido fue reembolsado. El reembolso puede tardar unos días en reflejarse.",
};

export function renderOrderStatusHtml(data: OrderStatusData): string {
  const label = STATUS_LABEL[data.status] ?? data.status;
  const msg =
    data.message ?? STATUS_MESSAGE[data.status] ?? `El estado de tu pedido cambió a: ${label}.`;
  const when = data.scheduledFor ? formatDateMx(data.scheduledFor, data.timezone) : null;
  const inner = `
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;margin:0 0 4px;">${escapeHtml(label)}</h1>
<div style="color:${C.ink2};font-size:13px;">Pedido <strong style="color:${C.ink};">${escapeHtml(data.folio)}</strong></div>
<p style="margin:16px 0 8px;">${data.customerName ? `Hola ${escapeHtml(data.customerName)}, ` : ""}${escapeHtml(msg)}</p>
${when || data.pickupPoint ? `<div style="padding:12px;background:${C.cream};border-radius:8px;font-size:14px;">${when ? `<div><strong>Fecha:</strong> ${escapeHtml(when)}</div>` : ""}${data.pickupPoint ? `<div><strong>Sucursal:</strong> ${escapeHtml(data.pickupPoint.name)}${data.pickupPoint.address ? ` · ${escapeHtml(data.pickupPoint.address)}` : ""}</div>` : ""}</div>` : ""}
${button(data.statusUrl, "Ver mi pedido")}`;
  return layout(
    { businessName: data.businessName, logoUrl: data.logoUrl, siteUrl: data.siteUrl },
    `Pedido ${data.folio}: ${label}`,
    inner,
    `${label} · Pedido ${data.folio}`,
  );
}

export async function sendOrderStatusEmail(
  to: string,
  data: OrderStatusData,
): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  const label = STATUS_LABEL[data.status] ?? data.status;
  return sendEmail({
    to,
    subject: `Pedido ${data.folio}: ${label} · ${data.businessName}`,
    html: renderOrderStatusHtml(data),
    text: `${data.businessName} — Pedido ${data.folio}: ${label}\n${data.message ?? STATUS_MESSAGE[data.status] ?? ""}\n${data.statusUrl}`,
    idempotencyKey: `order-status:${data.folio}:${data.status}:${to.toLowerCase()}`,
  });
}

// ── Acceso al portal del cliente ────────────────────────────────────────────
// Enlace de un solo uso para entrar a /portal. Lo dispara el propio cliente desde /portal/entrar
// o el staff desde la ficha del CRM. Usa el mismo maquetado que el resto de los correos.

export type PortalAccessData = {
  businessName: string;
  /** Nombre de pila para el saludo. */
  firstName: string;
  /** URL absoluta con el token (https). */
  link: string;
  /** Minutos que le quedan de vida al enlace. */
  minutes: number;
  logoUrl?: string | null;
  siteUrl?: string | null;
};

export function renderPortalAccessHtml(data: PortalAccessData): string {
  const inner = `
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:22px;margin:0 0 4px;">Entra a tu cuenta</h1>
<p style="margin:16px 0 8px;">Hola ${escapeHtml(data.firstName)}, este es tu enlace para ver tus puntos, tus compras y tu QR del club de ${escapeHtml(data.businessName)}.</p>
${button(data.link, "Entrar a mi cuenta")}
<div style="font-size:12px;color:${C.ink2};text-align:center;">Si el botón no funciona, copia este enlace:<br><a href="${safeUrl(data.link) ?? "#"}" style="color:${C.wine};word-break:break-all;">${escapeHtml(data.link)}</a></div>
<p style="margin:16px 0 0;font-size:12px;color:${C.ink2};">El enlace caduca en ${escapeHtml(data.minutes)} minutos y sirve una sola vez. Es personal: no lo compartas. Si no lo pediste, ignora este correo.</p>`;
  return layout(
    { businessName: data.businessName, logoUrl: data.logoUrl, siteUrl: data.siteUrl },
    `Entra a tu cuenta · ${data.businessName}`,
    inner,
    "Tu enlace para entrar al club",
  );
}

/**
 * Envía el enlace de acceso al portal. Sin proveedor configurado devuelve `{sent:false}` y quien llama
 * decide qué hacer (hoy: el CRM entrega el enlace a mano). SIN `idempotencyKey`: cada solicitud genera
 * un token nuevo y el cliente debe recibir el último, no una copia deduplicada del anterior.
 */
export async function sendPortalAccessEmail(
  to: string,
  data: PortalAccessData,
): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  if (!safeUrl(data.link)) return { sent: false, error: "Enlace inválido" };
  return sendEmail({
    to,
    subject: `Entra a tu cuenta · ${data.businessName}`,
    html: renderPortalAccessHtml(data),
    text: `Hola ${data.firstName}, entra a tu cuenta del club de ${data.businessName}: ${data.link}\nEl enlace caduca en ${data.minutes} minutos y sirve una sola vez.`,
  });
}

// ── Saludo de cumpleaños ────────────────────────────────────────────────────
// El texto lo arma @pdp/domain (birthdayGreetingMessage) y llega aquí ya redactado y aprobado por
// el staff: este módulo solo lo maqueta. Nunca se envía solo — lo dispara una acción del CRM.

export type BirthdayGreetingData = {
  businessName: string;
  /** Mensaje en texto plano, una idea por línea (salida de birthdayGreetingMessage). */
  message: string;
  /** Nombre del nivel del cliente, si se quiere mostrar como sello (VIP, Embajador…). */
  tierName?: string | null;
  logoUrl?: string | null;
  siteUrl?: string | null;
};

export function renderBirthdayGreetingHtml(data: BirthdayGreetingData): string {
  const [first = "", ...rest] = data.message.split("\n").filter((l) => l.trim());
  const body = rest.map((l) => `<p style="margin:0 0 10px;">${escapeHtml(l)}</p>`).join("");
  const inner = `
<div style="text-align:center;font-size:40px;line-height:1;margin:4px 0 12px;">🎂</div>
<h1 style="font-family:Georgia,serif;font-weight:normal;font-size:24px;margin:0 0 14px;text-align:center;">${escapeHtml(first)}</h1>
${data.tierName ? `<div style="text-align:center;margin:0 0 16px;"><span style="display:inline-block;padding:4px 12px;border:1px solid ${C.line};border-radius:999px;font-size:12px;color:${C.ink2};letter-spacing:.5px;text-transform:uppercase;">${escapeHtml(data.tierName)}</span></div>` : ""}
${body}`;
  return layout(
    { businessName: data.businessName, logoUrl: data.logoUrl, siteUrl: data.siteUrl },
    first || `¡Feliz cumpleaños! · ${data.businessName}`,
    inner,
    first,
  );
}

/**
 * Envía el saludo de cumpleaños. `idempotencyKey` va atado a cliente+año: si el staff hace doble clic
 * o reintenta, Resend deduplica durante 24 h y el cliente recibe un solo correo.
 */
export async function sendBirthdayGreetingEmail(
  to: string,
  data: BirthdayGreetingData & { subject: string; idempotencyKey: string },
): Promise<EmailResult> {
  if (!isEmailConfigured()) return { sent: false, skipped: "not_configured" };
  return sendEmail({
    to,
    subject: data.subject,
    html: renderBirthdayGreetingHtml(data),
    text: data.message,
    idempotencyKey: data.idempotencyKey,
  });
}

export { NotConfiguredError };
