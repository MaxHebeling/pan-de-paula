import "server-only";
import { timingSafeEqual } from "node:crypto";
import {
  createMercadoPagoPreference,
  isEmailConfigured,
  isMercadoPagoConfigured,
  sendEmail,
} from "@pdp/integrations";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@pdp/domain";
import { db, sql } from "@/lib/db";
import { dateMX, hourRange, money } from "@/lib/format";
import type { Business } from "@/lib/site";

export type OrderItem = {
  id: string;
  name: string;
  variantLabel: string | null;
  qty: number;
  unitPriceCents: number;
  totalCents: number;
  notes: string | null;
};
export type OrderPayment = {
  id: string;
  provider: string;
  method: string;
  status: string;
  amountCents: number;
  externalStatus: string | null;
  createdAt: Date;
};
export type OrderView = {
  id: string;
  folio: string;
  publicToken: string;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentType: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  pickupPoint: {
    name: string;
    address: string | null;
    notes: string | null;
    mapUrl: string | null;
  } | null;
  deliveryAddress: { street?: string; neighborhood?: string; references_note?: string } | null;
  scheduledFor: Date | null;
  windowName: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  couponCode: string | null;
  notes: string | null;
  placedAt: Date;
  items: OrderItem[];
  history: Array<{ toStatus: OrderStatus; note: string | null; at: Date }>;
  payments: OrderPayment[];
  /** Método elegido en el checkout, inferido de los registros del pedido. */
  paymentMethod: "cash" | "transfer" | "mercadopago";
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Pedido por folio + token público. Token incorrecto → null (la página responde 404). */
export async function getOrderByFolio(
  folio: string,
  token: string | null | undefined,
): Promise<OrderView | null> {
  if (!token || !/^[0-9a-f]{32}$/i.test(token) || !/^PDP-\d{4}-\d{6}$/.test(folio)) return null;
  const d = db();
  const o = await d
    .selectFrom("orders")
    .leftJoin("pickup_points", "pickup_points.id", "orders.pickup_point_id")
    .leftJoin("ordering_windows", "ordering_windows.id", "orders.ordering_window_id")
    .select([
      "orders.id",
      "orders.folio",
      "orders.public_token",
      "orders.status",
      "orders.payment_status",
      "orders.fulfillment_type",
      "orders.customer_name",
      "orders.customer_phone",
      "orders.customer_email",
      "orders.delivery_address",
      "orders.scheduled_for",
      "orders.subtotal_cents",
      "orders.discount_cents",
      "orders.delivery_fee_cents",
      "orders.tax_cents",
      "orders.total_cents",
      "orders.paid_cents",
      "orders.coupon_code",
      "orders.notes",
      "orders.placed_at",
      "pickup_points.name as pp_name",
      "pickup_points.address as pp_address",
      "pickup_points.notes as pp_notes",
      "pickup_points.map_url as pp_map",
      "ordering_windows.name as win_name",
      "ordering_windows.fulfillment_from as win_from",
      "ordering_windows.fulfillment_to as win_to",
    ])
    .where("orders.folio", "=", folio)
    .executeTakeFirst();
  if (!o || !safeEqual(o.public_token, token.toLowerCase())) return null;

  const [items, history, payments] = await Promise.all([
    d
      .selectFrom("order_items")
      .select([
        "id",
        "product_name",
        "variant_label",
        "qty",
        "unit_price_cents",
        "total_cents",
        "notes",
      ])
      .where("order_id", "=", o.id)
      .orderBy("sort_order")
      .execute(),
    d
      .selectFrom("order_status_history")
      .select(["to_status", "note", "created_at"])
      .where("order_id", "=", o.id)
      .orderBy("id")
      .execute(),
    d
      .selectFrom("payments")
      .select([
        "id",
        "provider",
        "method",
        "status",
        "amount_cents",
        "external_status",
        "created_at",
      ])
      .where("order_id", "=", o.id)
      .orderBy("created_at", "desc")
      .execute(),
  ]);

  const pays: OrderPayment[] = payments.map((p) => ({
    id: p.id,
    provider: p.provider,
    method: p.method,
    status: p.status,
    amountCents: p.amount_cents,
    externalStatus: p.external_status,
    createdAt: p.created_at,
  }));
  const paymentMethod: OrderView["paymentMethod"] = pays.some((p) => p.method === "transfer")
    ? "transfer"
    : pays.some((p) => p.provider === "mercadopago") ||
        o.status === "new" ||
        o.status === "payment_pending"
      ? "mercadopago"
      : "cash";

  return {
    id: o.id,
    folio: o.folio,
    publicToken: o.public_token,
    status: o.status,
    paymentStatus: o.payment_status,
    fulfillmentType: o.fulfillment_type,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    customerEmail: o.customer_email,
    pickupPoint: o.pp_name
      ? { name: o.pp_name, address: o.pp_address, notes: o.pp_notes, mapUrl: o.pp_map }
      : null,
    deliveryAddress: (o.delivery_address as OrderView["deliveryAddress"]) ?? null,
    scheduledFor: o.scheduled_for,
    windowName: o.win_name,
    windowFrom: o.win_from ? o.win_from.slice(0, 5) : null,
    windowTo: o.win_to ? o.win_to.slice(0, 5) : null,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    taxCents: o.tax_cents,
    totalCents: o.total_cents,
    paidCents: o.paid_cents,
    couponCode: o.coupon_code,
    notes: o.notes,
    placedAt: o.placed_at,
    items: items.map((i) => ({
      id: i.id,
      name: i.product_name,
      variantLabel: i.variant_label,
      qty: Number(i.qty),
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      notes: i.notes,
    })),
    history: history.map((h) => ({ toStatus: h.to_status, note: h.note, at: h.created_at })),
    payments: pays,
    paymentMethod,
  };
}

export function orderUrl(folio: string, token: string, extra?: Record<string, string>): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const q = new URLSearchParams({ t: token, ...(extra ?? {}) });
  return `${base}/pedido/${encodeURIComponent(folio)}?${q.toString()}`;
}

export function mercadoPagoAvailable(flags: Record<string, boolean>): boolean {
  return Boolean(flags.mercadopago_online) && isMercadoPagoConfigured();
}

/** Crea la preferencia de Checkout Pro para un pedido y devuelve la URL de pago. Lanza si MP falla. */
export async function startMercadoPago(order: OrderView, business: Business): Promise<string> {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const pref = await createMercadoPagoPreference({
    orderId: order.id,
    folio: order.folio,
    items: order.items.map((i) => ({
      id: i.id,
      title: i.variantLabel ? `${i.name} · ${i.variantLabel}` : i.name,
      quantity: i.qty,
      unitPriceCents: i.unitPriceCents,
    })),
    payer: {
      name: order.customerName ?? undefined,
      email: order.customerEmail ?? undefined,
      phone: order.customerPhone ?? undefined,
    },
    backUrls: {
      success: orderUrl(order.folio, order.publicToken, { mp: "success" }),
      failure: orderUrl(order.folio, order.publicToken, { mp: "failure" }),
      pending: orderUrl(order.folio, order.publicToken, { mp: "pending" }),
    },
    notificationUrl: `${base}/api/webhooks/mercadopago`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    statementDescriptor: business.name.slice(0, 22),
  });
  await sql`update orders set internal_notes = concat_ws(E'\n', internal_notes, ${"Mercado Pago: preferencia " + pref.preferenceId}::text) where id = ${order.id}`.execute(
    db(),
  );
  return pref.initPoint;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Email de confirmación (solo si el proveedor está configurado). Nunca interrumpe el flujo del pedido. */
export async function sendOrderConfirmationEmail(
  order: OrderView,
  business: Business,
): Promise<void> {
  if (!order.customerEmail || !isEmailConfigured()) return;
  const when = order.scheduledFor ? dateMX(order.scheduledFor, business.timezone) : "por confirmar";
  const hours = hourRange(order.windowFrom, order.windowTo);
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${i.qty} × ${escapeHtml(i.variantLabel ? `${i.name} · ${i.variantLabel}` : i.name)}</td><td style="padding:6px 0;text-align:right">${money(i.totalCents)}</td></tr>`,
    )
    .join("");
  const payLine =
    order.paymentMethod === "cash"
      ? "Pagas en efectivo al recoger."
      : order.paymentMethod === "transfer"
        ? "Pago por transferencia: revisa las instrucciones en la página de tu pedido."
        : "Pago en línea con Mercado Pago.";
  const link = orderUrl(order.folio, order.publicToken);
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;color:#1f2a3a;max-width:560px;margin:0 auto;padding:24px">
    <h1 style="font-family:Georgia,serif;font-weight:600;font-size:24px;margin:0 0 8px">¡Gracias, ${escapeHtml(order.customerName ?? "")}!</h1>
    <p style="margin:0 0 16px">Recibimos tu pedido <strong>${order.folio}</strong> en ${escapeHtml(business.name)}.</p>
    <p style="margin:0 0 4px"><strong>Fecha de recolección:</strong> ${escapeHtml(when)}${hours ? ` · ${escapeHtml(hours)}` : ""}</p>
    ${order.pickupPoint ? `<p style="margin:0 0 16px"><strong>Lugar:</strong> ${escapeHtml(order.pickupPoint.name)}${order.pickupPoint.address ? `, ${escapeHtml(order.pickupPoint.address)}` : ""}</p>` : ""}
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #e5e0d6;border-bottom:1px solid #e5e0d6;margin:16px 0">${rows}
      <tr><td style="padding:8px 0;font-weight:600">Total</td><td style="padding:8px 0;text-align:right;font-weight:600">${money(order.totalCents)}</td></tr>
    </table>
    <p style="margin:0 0 16px">${payLine}</p>
    <p style="margin:0 0 24px"><a href="${link}" style="background:#1f2a3a;color:#f7f3ec;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block">Ver mi pedido</a></p>
    <p style="font-size:12px;color:#3a4658">Estado actual: ${ORDER_STATUS_LABELS[order.status]}. Este enlace es personal: no lo compartas.</p>
  </div>`;
  try {
    const r = await sendEmail({
      to: order.customerEmail,
      subject: `Tu pedido ${order.folio} · ${business.name}`,
      html,
      text: `Recibimos tu pedido ${order.folio}. Recolección: ${when}. Total: ${money(order.totalCents)}. Ver: ${link}`,
      idempotencyKey: `order-confirmation-${order.id}`,
    });
    await sql`insert into receipts(order_id, channel, destination, status, error)
              values (${order.id}, 'email', ${order.customerEmail}, ${r.sent ? "sent" : "failed"}, ${r.sent ? null : (r.error ?? r.skipped ?? "no enviado")})`.execute(
      db(),
    );
  } catch (e) {
    console.error(`[orders] email de confirmación falló para ${order.folio}`, e);
    await sql`insert into receipts(order_id, channel, destination, status, error)
              values (${order.id}, 'email', ${order.customerEmail}, 'failed', ${(e as Error).message.slice(0, 500)})`
      .execute(db())
      .catch((err) => console.error("[orders] no se pudo registrar el intento de email", err));
  }
}
