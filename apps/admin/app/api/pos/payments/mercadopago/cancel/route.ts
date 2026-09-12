import { NextResponse } from "next/server";
import { z } from "zod";
import { db, callFn, withStaff } from "@/lib/db";
import { apiSession, dbErrorResponse, jsonError, readJson } from "@/lib/pos";

export const dynamic = "force-dynamic";

const schema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Cancela un intento de cobro Point/QR que no se confirmó. Si el webhook ya confirmó la venta,
 * NO cancela y devuelve sale_id para que el POS lo muestre como cobrado.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return jsonError(400, "orderId inválido", "VALIDATION");
  try {
    const r = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<{ cancelled: boolean; sale_id?: string | null; status: string }>(
        trx,
        "cancel_pending_pos_order",
        [parsed.data.orderId, parsed.data.reason ?? "Cobro Mercado Pago cancelado en POS"],
      ),
    );
    return NextResponse.json({
      cancelled: r.cancelled,
      saleId: r.sale_id ?? null,
      status: r.status,
    });
  } catch (e) {
    return dbErrorResponse(e, "cancel_pending_pos_order");
  }
}
