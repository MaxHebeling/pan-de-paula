import "server-only";
import { PAYMENT_METHOD_LABELS } from "@pdp/domain";
import type { ReceiptData } from "@pdp/integrations";
import { db, sql } from "@/lib/db";

/** Datos del comprobante (contrato ReceiptData de @pdp/integrations). */
export async function receiptData(orderId: string): Promise<ReceiptData | null> {
  const d = db();
  const o = await sql<{
    folio: string;
    customer_name: string | null;
    customer_id: string | null;
    subtotal_cents: number;
    discount_cents: number;
    total_cents: number;
    sold_at: Date | null;
    placed_at: Date;
    business_name: string;
  }>`select o.folio, o.customer_name, o.customer_id, o.subtotal_cents, o.discount_cents, o.total_cents, s.sold_at, o.placed_at,
            (select name from business_settings where id = 1) as business_name
     from orders o left join sales s on s.order_id = o.id where o.id = ${orderId}`.execute(d);
  const order = o.rows[0];
  if (!order) return null;
  const [items, payments, loyalty] = await Promise.all([
    sql<{ product_name: string; qty: string; unit_price_cents: number; total_cents: number }>`
      select product_name, qty::text, unit_price_cents, total_cents from order_items where order_id = ${orderId} order by sort_order`.execute(
      d,
    ),
    sql<{ method: string; amount_cents: number }>`
      select method::text, amount_cents from payments where order_id = ${orderId} and status in ('paid','partially_refunded','refunded') order by created_at`.execute(
      d,
    ),
    sql<{ earned: number; balance: number }>`
      select coalesce((select sum(points) from loyalty_transactions lt join sales s on s.id = lt.sale_id where s.order_id = ${orderId} and lt.kind = 'earn'), 0)::int as earned,
             coalesce((select points_balance from customers where id = ${order.customer_id}), 0)::int as balance`.execute(
      d,
    ),
  ]);
  return {
    folio: order.folio,
    businessName: order.business_name,
    soldAt: new Date(order.sold_at ?? order.placed_at),
    items: items.rows.map((i) => ({
      name: i.product_name,
      qty: Number(i.qty),
      unitPriceCents: i.unit_price_cents,
      totalCents: i.total_cents,
    })),
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    totalCents: order.total_cents,
    payments: payments.rows.map((p) => ({
      method: PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method,
      amountCents: p.amount_cents,
    })),
    customerName: order.customer_name,
    pointsEarned: loyalty.rows[0]?.earned ?? 0,
    pointsBalance: order.customer_id ? (loyalty.rows[0]?.balance ?? 0) : undefined,
  };
}
