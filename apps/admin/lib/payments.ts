import "server-only";
import { sql } from "@/lib/db";

/**
 * Pagos de una venta/pedido para las vistas administrativas.
 *
 * La regla del negocio es que método + monto + REFERENCIA CONTABLE viajan juntos: en un pago dividido cada
 * parte es su propia fila de `payments` con su propia referencia, y perder la relación rompe la conciliación.
 * Por eso todas las vistas leen esta misma forma en vez de agregar métodos por su cuenta.
 *
 * `reference` es lo que escribe el negocio para conciliar (clave de rastreo, folio de terminal, id de depósito).
 * `externalId` es el identificador del PROVEEDOR (Mercado Pago) y se muestra aparte: nunca se mezclan.
 */
export type PaymentLine = {
  id: string;
  method: string;
  status: string;
  amountCents: number;
  reference: string | null;
  externalId: string | null;
};

/** Estados de pago que cuentan como dinero cobrado (los que se concilian). */
export const PAID_PAYMENT_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

/**
 * Sub-consulta `jsonb_agg` con los pagos cobrados de un pedido, en orden de captura.
 * `alias` es la columna del pedido con la que se relaciona (p. ej. `o.id`).
 */
export function paymentLinesSql(orderIdExpr: ReturnType<typeof sql>) {
  return sql<PaymentLine[] | null>`(
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'method', p.method::text, 'status', p.status::text,
             'amountCents', p.amount_cents, 'reference', p.reference, 'externalId', p.external_id
           ) order by p.created_at)
    from payments p
    where p.order_id = ${orderIdExpr} and p.status in ('paid','partially_refunded','refunded'))`;
}
