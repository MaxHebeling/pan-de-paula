import "server-only";
import type { OrderStatus } from "@pdp/domain";
import { db, sql } from "@/lib/db";

/**
 * Pedidos del cliente en su portal: los MISMOS `orders` que ve el CRM, en vivo.
 *
 * REGLA DE ORO (igual que en `data.ts`): el `customerId` sale SIEMPRE de la sesión y filtra en SQL.
 * El folio nunca decide de quién es un pedido: solo acota dentro de los suyos, así que el folio de
 * otra persona simplemente no existe para esta sesión (→ 404). Nada interno sale de aquí: ni costos,
 * ni `internal_notes`, ni ids de base, ni quién del equipo movió el estado.
 *
 * `/portal/compras` sigue mostrando las VENTAS cerradas (lo que ya existía). Esto es distinto: el
 * pedido mientras está vivo, desde que entra hasta que se entrega.
 */

/** El folio es el identificador público del pedido. */
const FOLIO_RE = /^PDP-\d{4}-\d{6}$/;

export type PortalOrderSummary = {
  folio: string;
  placedAt: Date;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentType: string;
  scheduledFor: Date | null;
  totalCents: number;
  itemsCount: number;
  /** "2 × Concha · 1 × Croissant" para la tarjeta de la lista. */
  summary: string;
  /** Última vez que cambió algo del pedido; con esto el portal sabe si hay novedad. */
  updatedAt: Date;
};

export type PortalOrderDetail = PortalOrderSummary & {
  channel: string;
  pickupPointName: string | null;
  pickupPointAddress: string | null;
  deliveryAddress: { street?: string; neighborhood?: string; references_note?: string } | null;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  paidCents: number;
  couponCode: string | null;
  notes: string | null;
  items: Array<{
    name: string;
    variantLabel: string | null;
    qty: number;
    unitPriceCents: number;
    totalCents: number;
    notes: string | null;
  }>;
  payments: Array<{ method: string; status: string; amountCents: number; at: Date }>;
  /** Historial completo: cada cambio guardado, nunca sobrescrito. */
  history: Array<{ status: OrderStatus; at: Date }>;
};

const SUMMARY = sql`
  (select string_agg(x.line, ' · ') from (
     select (case when oi.qty = trunc(oi.qty) then trunc(oi.qty)::text
                  else trim(trailing '0' from oi.qty::text) end) || ' × ' || oi.product_name as line
       from order_items oi where oi.order_id = o.id order by oi.sort_order limit 4
   ) x)`;

/**
 * "Cuándo cambió algo" de un pedido: su propio `updated_at` o el último movimiento de su historial,
 * lo que sea más reciente. Es lo que el sondeo compara para saber si hay que refrescar.
 */
const UPDATED_AT = sql`
  greatest(o.updated_at, coalesce((select max(h.created_at) from order_status_history h
                                    where h.order_id = o.id), o.updated_at))`;

/** Pedidos del cliente, del más reciente al más viejo. Incluye los ya entregados: son su historial. */
export async function listPortalOrders(
  customerId: string,
  limit = 30,
): Promise<PortalOrderSummary[]> {
  const r = await sql<{
    folio: string;
    placed_at: Date;
    status: OrderStatus;
    payment_status: string;
    fulfillment_type: string;
    scheduled_for: Date | null;
    total_cents: number;
    items_count: number;
    summary: string | null;
    updated_at: Date;
  }>`
    select o.folio, o.placed_at, o.status, o.payment_status, o.fulfillment_type, o.scheduled_for,
           o.total_cents,
           (select count(*)::int from order_items oi where oi.order_id = o.id) as items_count,
           ${SUMMARY} as summary,
           ${UPDATED_AT} as updated_at
      from orders o
     where o.customer_id = ${customerId}
     order by o.placed_at desc
     limit ${limit}`.execute(db());
  return r.rows.map((o) => ({
    folio: o.folio,
    placedAt: o.placed_at,
    status: o.status,
    paymentStatus: o.payment_status,
    fulfillmentType: o.fulfillment_type,
    scheduledFor: o.scheduled_for,
    totalCents: o.total_cents,
    itemsCount: o.items_count,
    summary: o.summary ?? "",
    updatedAt: o.updated_at,
  }));
}

/** Detalle de UN pedido del cliente de la sesión, con su historial de estados. */
export async function getPortalOrder(
  customerId: string,
  folio: string,
): Promise<PortalOrderDetail | null> {
  const clean = folio.trim().toUpperCase();
  if (!FOLIO_RE.test(clean)) return null;
  const r = await sql<{
    id: string;
    folio: string;
    placed_at: Date;
    status: OrderStatus;
    payment_status: string;
    channel: string;
    fulfillment_type: string;
    scheduled_for: Date | null;
    pickup_point_name: string | null;
    pickup_point_address: string | null;
    delivery_address: PortalOrderDetail["deliveryAddress"];
    subtotal_cents: number;
    discount_cents: number;
    delivery_fee_cents: number;
    tax_cents: number;
    tip_cents: number;
    total_cents: number;
    paid_cents: number;
    coupon_code: string | null;
    notes: string | null;
    items_count: number;
    summary: string | null;
    updated_at: Date;
  }>`
    select o.id, o.folio, o.placed_at, o.status, o.payment_status, o.channel, o.fulfillment_type,
           o.scheduled_for, pp.name as pickup_point_name, pp.address as pickup_point_address,
           o.delivery_address, o.subtotal_cents, o.discount_cents, o.delivery_fee_cents,
           o.tax_cents, o.tip_cents, o.total_cents, o.paid_cents, o.coupon_code, o.notes,
           (select count(*)::int from order_items oi where oi.order_id = o.id) as items_count,
           ${SUMMARY} as summary,
           ${UPDATED_AT} as updated_at
      from orders o
      left join pickup_points pp on pp.id = o.pickup_point_id
     where o.customer_id = ${customerId} and o.folio = ${clean}
     limit 1`.execute(db());
  const o = r.rows[0];
  if (!o) return null;

  const [items, payments, history] = await Promise.all([
    sql<{
      product_name: string;
      variant_label: string | null;
      qty: string;
      unit_price_cents: number;
      total_cents: number;
      notes: string | null;
    }>`select product_name, variant_label, qty, unit_price_cents, total_cents, notes
         from order_items where order_id = ${o.id} order by sort_order`.execute(db()),
    sql<{ method: string; status: string; amount_cents: number; created_at: Date }>`
      select method, status, amount_cents, created_at from payments
       where order_id = ${o.id} and status in ('paid', 'partial', 'authorized', 'pending')
       order by created_at`.execute(db()),
    // El historial es del pedido, no del equipo: no sale `staff_id` ni la nota interna.
    sql<{ to_status: OrderStatus; created_at: Date }>`
      select to_status, created_at from order_status_history
       where order_id = ${o.id} order by created_at, id`.execute(db()),
  ]);

  return {
    folio: o.folio,
    placedAt: o.placed_at,
    status: o.status,
    paymentStatus: o.payment_status,
    channel: o.channel,
    fulfillmentType: o.fulfillment_type,
    scheduledFor: o.scheduled_for,
    pickupPointName: o.pickup_point_name,
    pickupPointAddress: o.pickup_point_address,
    deliveryAddress: o.delivery_address,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    taxCents: o.tax_cents,
    tipCents: o.tip_cents,
    totalCents: o.total_cents,
    paidCents: o.paid_cents,
    couponCode: o.coupon_code,
    notes: o.notes,
    itemsCount: o.items_count,
    summary: o.summary ?? "",
    updatedAt: o.updated_at,
    items: items.rows.map((i) => ({
      name: i.product_name,
      variantLabel: i.variant_label,
      qty: Number(i.qty),
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
      notes: i.notes,
    })),
    payments: payments.rows.map((p) => ({
      method: p.method,
      status: p.status,
      amountCents: p.amount_cents,
      at: p.created_at,
    })),
    history: history.rows.map((h) => ({ status: h.to_status, at: h.created_at })),
  };
}

export type PortalNotification = {
  id: string;
  folio: string | null;
  kind: string;
  title: string;
  body: string | null;
  at: Date;
  read: boolean;
};

/** Avisos del cliente (los genera la base al cambiar el estado de su pedido). */
export async function listPortalNotifications(
  customerId: string,
  limit = 30,
): Promise<PortalNotification[]> {
  const r = await sql<{
    id: string;
    folio: string | null;
    kind: string;
    title: string;
    body: string | null;
    created_at: Date;
    read_at: Date | null;
  }>`
    select n.id, o.folio, n.kind, n.title, n.body, n.created_at, n.read_at
      from customer_notifications n
      left join orders o on o.id = n.order_id
     where n.customer_id = ${customerId}
     order by n.created_at desc
     limit ${limit}`.execute(db());
  return r.rows.map((n) => ({
    id: n.id,
    folio: n.folio,
    kind: n.kind,
    title: n.title,
    body: n.body,
    at: n.created_at,
    read: n.read_at !== null,
  }));
}

export const countUnreadNotifications = async (customerId: string): Promise<number> =>
  sql<{ n: number }>`select count(*)::int as n from customer_notifications
                      where customer_id = ${customerId} and read_at is null`
    .execute(db())
    .then((r) => r.rows[0]?.n ?? 0);

/** Marca como leídos los avisos del cliente (todos, o los de un pedido). */
export async function markNotificationsRead(customerId: string, folio?: string): Promise<void> {
  if (folio) {
    const clean = folio.trim().toUpperCase();
    if (!FOLIO_RE.test(clean)) return;
    await sql`update customer_notifications n set read_at = now()
               from orders o
              where n.order_id = o.id and o.folio = ${clean}
                and n.customer_id = ${customerId} and n.read_at is null`.execute(db());
    return;
  }
  await sql`update customer_notifications set read_at = now()
             where customer_id = ${customerId} and read_at is null`.execute(db());
}

/**
 * Lo mínimo que el portal necesita para saber si algo cambió, en una sola consulta barata: el estado
 * de cada pedido abierto, cuándo cambió por última vez y cuántos avisos sin leer hay. Es lo que
 * devuelve el endpoint que sondea la pantalla.
 */
export async function portalPulse(customerId: string): Promise<{
  unread: number;
  orders: Array<{ folio: string; status: OrderStatus; updatedAt: string }>;
}> {
  const [unread, orders] = await Promise.all([
    countUnreadNotifications(customerId),
    sql<{ folio: string; status: OrderStatus; updated_at: Date }>`
      select o.folio, o.status, ${UPDATED_AT} as updated_at
        from orders o
       where o.customer_id = ${customerId}
       order by o.placed_at desc
       limit 30`.execute(db()),
  ]);
  return {
    unread,
    orders: orders.rows.map((o) => ({
      folio: o.folio,
      status: o.status,
      updatedAt: o.updated_at.toISOString(),
    })),
  };
}
