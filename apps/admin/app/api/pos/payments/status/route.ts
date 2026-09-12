import { NextResponse } from "next/server";
import { z } from "zod";
import { db, sql } from "@/lib/db";
import { apiSession, dbErrorResponse, jsonError } from "@/lib/pos";
import type { PaymentStatusResult } from "@/components/pos/types";

export const dynamic = "force-dynamic";

/**
 * Estado real de un cobro (Mercado Pago Point/QR). El POS SOLO consulta: la confirmación la escribe el
 * webhook vía apply_mercadopago_payment. "confirmed" únicamente cuando existe la venta (sales).
 */
export async function GET(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const orderId = new URL(req.url).searchParams.get("orderId");
  if (!orderId || !z.string().uuid().safeParse(orderId).success)
    return jsonError(400, "orderId inválido", "VALIDATION");
  try {
    const d = db();
    const o = await sql<{
      id: string;
      folio: string;
      status: string;
      payment_status: string;
      total_cents: number;
      paid_cents: number;
      sale_id: string | null;
      points_earned: number;
    }>`select o.id, o.folio, o.status, o.payment_status, o.total_cents, o.paid_cents, s.id as sale_id,
              coalesce((select sum(points) from loyalty_transactions lt where lt.sale_id = s.id and lt.kind = 'earn'), 0)::int as points_earned
       from orders o left join sales s on s.order_id = o.id and s.voided_at is null
       where o.id = ${orderId}::uuid`.execute(d);
    const row = o.rows[0];
    if (!row) return jsonError(404, "Pedido no encontrado", "NOT_FOUND");
    const pays = await sql<{
      method: string;
      status: string;
      amount_cents: number;
      external_status: string | null;
    }>`select method, status, amount_cents, external_status from payments where order_id = ${orderId}::uuid order by created_at`.execute(
      d,
    );
    const payments = pays.rows.map((p) => ({
      method: p.method,
      status: p.status,
      amountCents: p.amount_cents,
      externalStatus: p.external_status,
    }));
    let outcome: PaymentStatusResult["outcome"] = "pending";
    if (row.sale_id) outcome = "confirmed";
    else if (
      row.status === "cancelled" ||
      row.status === "refunded" ||
      (payments.length > 0 && payments.every((p) => p.status === "failed" || p.status === "cancelled"))
    )
      outcome = "failed";
    const out: PaymentStatusResult = {
      orderId: row.id,
      folio: row.folio,
      status: row.status,
      paymentStatus: row.payment_status,
      totalCents: row.total_cents,
      paidCents: row.paid_cents,
      saleId: row.sale_id,
      pointsEarned: row.points_earned,
      payments,
      outcome,
    };
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return dbErrorResponse(e, "estado de pago");
  }
}
