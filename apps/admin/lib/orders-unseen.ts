import "server-only";
import { db, sql } from "@/lib/db";

/**
 * Pedidos "sin ver": llegaron solos (web, Instagram, WhatsApp sin staff), siguen vivos y nadie del equipo ha
 * abierto su detalle. Los que crea el personal (POS, pedido manual) y las ventas históricas importadas no cuentan.
 */
/** Condición SQL de "sin ver" sobre un pedido con alias `o` (misma regla en el contador y en la lista). */
export const UNSEEN_ORDER_SQL = sql<boolean>`(
  o.created_by is null
  and o.status not in ('cancelled', 'refunded')
  and o.channel <> 'pos'
  and coalesce(o.source_ref, '') not like 'import:%'
  and not exists (select 1 from order_first_views v where v.order_id = o.id)
)`;

export async function countUnseenOrders(): Promise<number> {
  const r = await sql<{
    n: number;
  }>`select count(*)::int as n from orders o where ${UNSEEN_ORDER_SQL}`.execute(db());
  return r.rows[0]?.n ?? 0;
}

/** Registra la primera vista del pedido. Devuelve true solo si esta vista fue la primera. */
export async function markOrderSeen(orderId: string, staffId: string): Promise<boolean> {
  const r = await sql<{ order_id: string }>`
    insert into order_first_views (order_id, staff_id)
    select o.id, ${staffId}::uuid from orders o where o.id = ${orderId}::uuid
    on conflict (order_id) do nothing
    returning order_id`.execute(db());
  return r.rows.length > 0;
}
