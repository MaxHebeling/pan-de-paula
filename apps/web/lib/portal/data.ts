import "server-only";
import { db, sql } from "@/lib/db";

/**
 * Consultas del portal del cliente.
 *
 * REGLA DE ORO: todas reciben el `customerId` de la SESIÓN y filtran por él en SQL. Ningún dato del
 * cliente (folio, código, id) decide de quién son los datos: el folio solo acota DENTRO de sus compras.
 * Tampoco sale nada interno: ni costos, ni márgenes, ni `internal_notes`, ni ids de base.
 *
 * Fuente de verdad: las MISMAS tablas que lee el CRM (`sales`, `orders`, `order_items`, `payments`,
 * `loyalty_transactions`, `customers`). No hay copias ni cachés: una venta nueva del POS o de la web
 * aparece aquí en cuanto la función SQL correspondiente la registra.
 */

export type PortalCustomer = {
  id: string;
  fullName: string;
  publicCode: string;
  qrToken: string;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  source: string;
  createdAt: Date;
  tierKey: string | null;
  pointsBalance: number;
  lifetimePoints: number;
  totalOrders: number;
  totalSpentCents: number;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  marketingConsent: boolean;
};

/** Canal por el que el cliente se dio de alta (`customers.source`), en lenguaje de cliente. */
export const SOURCE_LABELS: Record<string, string> = {
  pos: "En la panadería",
  qr: "Con el QR del club",
  web: "En el sitio web",
  instagram: "Por Instagram",
  import: "Registro histórico",
  admin: "Alta del equipo",
};

/** Canal de la compra. */
export const PURCHASE_CHANNEL_LABELS: Record<string, string> = {
  pos: "En la panadería",
  web: "Pedido en línea",
  admin: "Pedido por el equipo",
  instagram: "Pedido por Instagram",
  whatsapp: "Pedido por WhatsApp",
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  pickup: "Recoger en tienda",
  scheduled_pickup: "Recoger en fecha programada",
  delivery: "Entrega a domicilio",
  preorder: "Pedido anticipado",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  mercadopago: "Mercado Pago",
  card_terminal: "Tarjeta",
  transfer: "Transferencia",
  points: "Puntos",
  other: "Otro",
};

/** Conceptos del ledger de puntos en lenguaje de cliente (nunca la nota interna del staff). */
export const POINTS_KIND_LABELS: Record<string, string> = {
  earn: "Puntos por tu compra",
  bonus: "Puntos de regalo",
  redeem: "Canje de recompensa",
  adjust: "Ajuste del equipo",
  expire: "Puntos vencidos",
  reversal: "Devolución de puntos",
};

/** Ficha del cliente de la sesión. Se lee siempre de `customers`: mismos totales que ve el CRM. */
export async function getPortalCustomer(customerId: string): Promise<PortalCustomer | null> {
  const r = await sql<{
    id: string;
    full_name: string;
    public_code: string;
    qr_token: string;
    email: string | null;
    phone: string | null;
    birthday: string | null;
    source: string;
    created_at: Date;
    tier_key: string | null;
    points_balance: number;
    lifetime_points: number;
    total_orders: number;
    total_spent_cents: number;
    first_purchase_at: Date | null;
    last_purchase_at: Date | null;
    marketing_consent: boolean;
  }>`select id, full_name, public_code, qr_token, email, phone, birthday::text as birthday, source,
            created_at, tier_key, points_balance, lifetime_points, total_orders, total_spent_cents,
            first_purchase_at, last_purchase_at, marketing_consent
       from customers
      where id = ${customerId} and deleted_at is null and merged_into_id is null`.execute(db());
  const c = r.rows[0];
  if (!c) return null;
  return {
    id: c.id,
    fullName: c.full_name,
    publicCode: c.public_code,
    qrToken: c.qr_token,
    email: c.email,
    phone: c.phone,
    birthday: c.birthday,
    source: c.source,
    createdAt: c.created_at,
    tierKey: c.tier_key,
    pointsBalance: c.points_balance,
    lifetimePoints: c.lifetime_points,
    totalOrders: c.total_orders,
    totalSpentCents: Number(c.total_spent_cents),
    firstPurchaseAt: c.first_purchase_at,
    lastPurchaseAt: c.last_purchase_at,
    marketingConsent: c.marketing_consent,
  };
}

export type PortalPurchase = {
  folio: string;
  soldAt: Date;
  channel: string;
  totalCents: number;
  itemsCount: number;
  pointsEarned: number;
  voided: boolean;
  /** Resumen "2 × Croissant · 1 × Kouign-amann" para la lista. */
  summary: string;
};

/** El folio es el identificador público del pedido; nunca se exponen ids internos. */
const FOLIO_RE = /^PDP-\d{4}-\d{6}$/;

/** Compras del cliente (ventas cerradas). Las anuladas se marcan, no se ocultan. */
export async function listPortalPurchases(
  customerId: string,
  limit = 50,
): Promise<PortalPurchase[]> {
  const r = await sql<{
    folio: string;
    sold_at: Date;
    channel: string;
    total_cents: number;
    items_count: string;
    points_earned: number;
    voided: boolean;
    summary: string | null;
  }>`
    select o.folio, s.sold_at, o.channel, s.total_cents, s.items_count,
           coalesce((select sum(lt.points)::int from loyalty_transactions lt
                      where lt.sale_id = s.id and lt.points > 0), 0) as points_earned,
           (s.voided_at is not null) as voided,
           (select string_agg(x.line, ' · ') from (
              select (case when oi.qty = trunc(oi.qty) then trunc(oi.qty)::text else trim(trailing '0' from oi.qty::text) end)
                     || ' × ' || oi.product_name as line
                from order_items oi where oi.order_id = o.id order by oi.sort_order limit 4
            ) x) as summary
      from sales s join orders o on o.id = s.order_id
     where s.customer_id = ${customerId}
     order by s.sold_at desc
     limit ${limit}`.execute(db());
  return r.rows.map((p) => ({
    folio: p.folio,
    soldAt: p.sold_at,
    channel: p.channel,
    totalCents: p.total_cents,
    itemsCount: Number(p.items_count),
    pointsEarned: p.points_earned,
    voided: p.voided,
    summary: p.summary ?? "",
  }));
}

export type PortalPurchaseDetail = {
  folio: string;
  soldAt: Date;
  channel: string;
  fulfillmentType: string;
  pickupPointName: string | null;
  scheduledFor: Date | null;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  couponCode: string | null;
  voided: boolean;
  pointsEarned: number;
  items: Array<{
    name: string;
    variantLabel: string | null;
    qty: number;
    unitPriceCents: number;
    discountCents: number;
    totalCents: number;
  }>;
  payments: Array<{ method: string; amountCents: number }>;
};

/**
 * Detalle de UNA compra del cliente de la sesión. El folio nunca se usa solo: la consulta exige
 * `sales.customer_id = <sesión>`, así que el folio de otra persona simplemente no existe (→ 404).
 */
export async function getPortalPurchase(
  customerId: string,
  folio: string,
): Promise<PortalPurchaseDetail | null> {
  const clean = folio.trim().toUpperCase();
  if (!FOLIO_RE.test(clean)) return null;
  const r = await sql<{
    sale_id: string;
    order_id: string;
    folio: string;
    sold_at: Date;
    channel: string;
    fulfillment_type: string;
    pickup_point_name: string | null;
    scheduled_for: Date | null;
    subtotal_cents: number;
    discount_cents: number;
    delivery_fee_cents: number;
    tax_cents: number;
    tip_cents: number;
    total_cents: number;
    coupon_code: string | null;
    voided: boolean;
    points_earned: number;
  }>`
    select s.id as sale_id, o.id as order_id, o.folio, s.sold_at, o.channel, o.fulfillment_type,
           pp.name as pickup_point_name, o.scheduled_for,
           s.subtotal_cents, s.discount_cents, o.delivery_fee_cents, s.tax_cents, s.tip_cents,
           s.total_cents, o.coupon_code, (s.voided_at is not null) as voided,
           coalesce((select sum(lt.points)::int from loyalty_transactions lt
                      where lt.sale_id = s.id and lt.points > 0), 0) as points_earned
      from sales s
      join orders o on o.id = s.order_id
      left join pickup_points pp on pp.id = o.pickup_point_id
     where s.customer_id = ${customerId} and o.folio = ${clean}
     limit 1`.execute(db());
  const p = r.rows[0];
  if (!p) return null;

  const [items, payments] = await Promise.all([
    sql<{
      product_name: string;
      variant_label: string | null;
      qty: string;
      unit_price_cents: number;
      discount_cents: number;
      total_cents: number;
    }>`select product_name, variant_label, qty, unit_price_cents, discount_cents, total_cents
         from order_items where order_id = ${p.order_id} order by sort_order`.execute(db()),
    sql<{ method: string; amount_cents: number }>`
      select method, amount_cents from payments
       where order_id = ${p.order_id} and status in ('paid', 'partial', 'authorized')
       order by created_at`.execute(db()),
  ]);

  return {
    folio: p.folio,
    soldAt: p.sold_at,
    channel: p.channel,
    fulfillmentType: p.fulfillment_type,
    pickupPointName: p.pickup_point_name,
    scheduledFor: p.scheduled_for,
    subtotalCents: p.subtotal_cents,
    discountCents: p.discount_cents,
    deliveryFeeCents: p.delivery_fee_cents,
    taxCents: p.tax_cents,
    tipCents: p.tip_cents,
    totalCents: p.total_cents,
    couponCode: p.coupon_code,
    voided: p.voided,
    pointsEarned: p.points_earned,
    items: items.rows.map((i) => ({
      name: i.product_name,
      variantLabel: i.variant_label,
      qty: Number(i.qty),
      unitPriceCents: i.unit_price_cents,
      discountCents: i.discount_cents,
      totalCents: i.total_cents,
    })),
    payments: payments.rows.map((x) => ({ method: x.method, amountCents: x.amount_cents })),
  };
}

export type PortalPointsMovement = {
  id: number;
  kind: string;
  points: number;
  balanceAfter: number;
  createdAt: Date;
  /** Folio de la compra que generó el movimiento, si lo hubo. */
  folio: string | null;
};

/** Movimientos del ledger de puntos del cliente. No se expone la nota interna del staff. */
export async function listPortalPointsMovements(
  customerId: string,
  limit = 100,
): Promise<PortalPointsMovement[]> {
  const r = await sql<{
    id: string;
    kind: string;
    points: number;
    balance_after: number;
    created_at: Date;
    folio: string | null;
  }>`select lt.id, lt.kind, lt.points, lt.balance_after, lt.created_at, o.folio
       from loyalty_transactions lt
       left join sales s on s.id = lt.sale_id
       left join orders o on o.id = s.order_id
      where lt.customer_id = ${customerId}
      order by lt.created_at desc, lt.id desc
      limit ${limit}`.execute(db());
  return r.rows.map((m) => ({
    id: Number(m.id),
    kind: m.kind,
    points: m.points,
    balanceAfter: m.balance_after,
    createdAt: m.created_at,
    folio: m.folio,
  }));
}
