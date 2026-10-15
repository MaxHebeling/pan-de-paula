import "server-only";
import { db, sql } from "@/lib/db";

/**
 * Cobro de un pedido guardado desde el punto de venta.
 *
 * Es una CONSULTA, no una copia: el pedido sigue viviendo en `orders` y aquí solo se lee. No hay
 * carrito, no hay líneas que editar y no se vuelve a resolver nada contra el catálogo.
 *
 * Por qué eso importa: `order_items` guarda `product_name`, `variant_label`, `unit_price_cents`,
 * `discount_cents` y `notes` denormalizados en el momento del pedido. Leerlos tal cual conserva los
 * precios acordados, los productos especiales que no tienen un producto estándar detrás y las notas
 * de cada renglón, sin riesgo de sustituirlos en silencio por los precios de hoy.
 *
 * El saldo se calcula igual que en `record_payment` y `queue_order_for_pos`: total menos pagado. Los
 * reembolsos no reabren saldo; eso es `record_refund`, un flujo aparte.
 */

export type CollectItem = {
  id: string;
  product_name: string;
  variant_label: string | null;
  qty: string;
  unit_price_cents: number;
  discount_cents: number;
  total_cents: number;
  notes: string | null;
};

export type CollectPayment = {
  id: string;
  method: string;
  status: string;
  amount_cents: number;
  reference: string | null;
  created_at: Date;
  confirmed_at: Date | null;
};

export type CollectOrder = {
  id: string;
  folio: string;
  channel: string;
  status: string;
  payment_status: string;
  fulfillment_type: string;
  customer_name: string | null;
  customer_phone: string | null;
  pickup_name: string | null;
  delivery_address: Record<string, string> | null;
  scheduled_for: Date | null;
  subtotal_cents: number;
  discount_cents: number;
  delivery_fee_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  paid_cents: number;
  refunded_cents: number;
  coupon_code: string | null;
  notes: string | null;
  internal_notes: string | null;
  pos_queued_at: Date | null;
  pos_queued_by_name: string | null;
  sale_id: string | null;
  sale_voided_at: Date | null;
  items: CollectItem[];
  payments: CollectPayment[];
};

/** Saldo por cobrar. Nunca negativo: un pedido sobrepagado no debe mostrar un saldo a favor aquí. */
export function balanceCents(o: Pick<CollectOrder, "total_cents" | "paid_cents">): number {
  return Math.max(0, o.total_cents - o.paid_cents);
}

/**
 * ¿Se puede cobrar este pedido ahora mismo?
 * Las mismas tres condiciones que valida `queue_order_for_pos` en la base, para que la pantalla no
 * ofrezca un botón que el servidor va a rechazar. La base manda; esto solo evita el viaje en vano.
 */
export function collectState(
  o: Pick<CollectOrder, "status" | "total_cents" | "paid_cents" | "pos_queued_at">,
): "cobrable" | "pagado" | "no_elegible" {
  if (o.status === "cancelled" || o.status === "refunded") return "no_elegible";
  if (balanceCents(o) <= 0) return "pagado";
  return "cobrable";
}

export async function loadOrderForCollect(id: string): Promise<CollectOrder | null> {
  const head = await sql<Omit<CollectOrder, "items" | "payments">>`
    select o.id, o.folio, o.channel::text as channel, o.status::text as status,
           o.payment_status::text as payment_status, o.fulfillment_type::text as fulfillment_type,
           o.customer_name, o.customer_phone,
           pp.name as pickup_name, o.delivery_address, o.scheduled_for,
           o.subtotal_cents, o.discount_cents, o.delivery_fee_cents, o.tax_cents, o.tip_cents,
           o.total_cents, o.paid_cents, o.refunded_cents, o.coupon_code, o.notes, o.internal_notes,
           o.pos_queued_at, su.full_name as pos_queued_by_name,
           s.id as sale_id, s.voided_at as sale_voided_at
      from orders o
      left join pickup_points pp on pp.id = o.pickup_point_id
      left join staff_users su on su.id = o.pos_queued_by
      left join sales s on s.order_id = o.id and s.voided_at is null
     where o.id = ${id}`.execute(db());
  const o = head.rows[0];
  if (!o) return null;
  const [items, payments] = await Promise.all([
    sql<CollectItem>`
      select id, product_name, variant_label, qty::text, unit_price_cents, discount_cents,
             total_cents, notes
        from order_items where order_id = ${id} order by sort_order`.execute(db()),
    sql<CollectPayment>`
      select id, method::text as method, status::text as status, amount_cents, reference,
             created_at, confirmed_at
        from payments where order_id = ${id} order by created_at`.execute(db()),
  ]);
  return { ...o, items: items.rows, payments: payments.rows };
}

/**
 * Cola de pedidos pendientes de cobro en el punto de venta.
 *
 * Se consulta de la base, no de memoria ni de la URL ni del navegador: cerrar la pantalla, cambiar
 * de sección o recargar no pierde nada. El índice `orders_pos_queue_idx` cubre exactamente este
 * filtro.
 */
export type PendingRow = {
  id: string;
  folio: string;
  channel: string;
  status: string;
  fulfillment_type: string;
  customer_name: string | null;
  total_cents: number;
  paid_cents: number;
  scheduled_for: Date | null;
  pos_queued_at: Date;
};

export async function listPendingPosOrders(term = ""): Promise<PendingRow[]> {
  const q = term.trim();
  return (
    await sql<PendingRow>`
      select o.id, o.folio, o.channel::text as channel, o.status::text as status,
             o.fulfillment_type::text as fulfillment_type, o.customer_name,
             o.total_cents, o.paid_cents, o.scheduled_for, o.pos_queued_at
        from orders o
       where o.pos_queued_at is not null
         and o.payment_status <> 'paid'
         and o.status not in ('cancelled', 'refunded')
         and o.total_cents > o.paid_cents
         and (${q} = '' or o.folio ilike '%' || ${q} || '%'
              or coalesce(o.customer_name, '') ilike '%' || ${q} || '%')
       order by o.pos_queued_at desc
       limit 50`.execute(db())
  ).rows;
}
