import { NextResponse } from "next/server";
import { posCheckoutSchema } from "@pdp/domain";
import { hasPermission } from "@/lib/auth";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { apiSession, dbErrorResponse, getOpenRegister, jsonError, readJson } from "@/lib/pos";
import type { CheckoutResult } from "@/components/pos/types";

export const dynamic = "force-dynamic";

type PosCheckoutRow = {
  order_id: string;
  sale_id: string | null;
  folio: string;
  total_cents: number;
  paid_cents?: number;
  change_cents?: number;
  points_earned?: number;
  status?: string;
  duplicate: boolean;
};

/**
 * Venta rápida del POS. El cliente manda product_id + qty; el servidor (pos_checkout) decide precios,
 * descuenta stock, otorga puntos y registra pagos en UNA transacción, idempotente por idempotency_key.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  const parsed = posCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message ?? "Datos inválidos", "VALIDATION");
  }
  const input = parsed.data;

  if (input.items.some((i) => (i.discount_cents ?? 0) > 0) && !hasPermission(auth.session, "pos.refund")) {
    return jsonError(403, "Los descuentos por línea requieren permiso de gerente", "DISCOUNT_FORBIDDEN");
  }
  if (input.payments.some((p) => p.provider === "mercadopago" || p.method === "mercadopago")) {
    return jsonError(
      400,
      "Los cobros con Mercado Pago se inician en /api/pos/payments/mercadopago y se confirman por webhook",
      "MP_NOT_HERE",
    );
  }
  const register = await getOpenRegister();
  if (input.payments.some((p) => p.method === "cash") && !register) {
    return jsonError(409, "La caja está cerrada. Ábrela para cobrar en efectivo.", "REGISTER_CLOSED");
  }

  const payload = {
    ...input,
    channel: "pos",
    register_session_id: register?.id ?? null,
  };
  try {
    const res = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<PosCheckoutRow>(trx, "pos_checkout", [JSON.stringify(payload)]),
    );
    let pointsBalance: number | null = null;
    if (input.customer_id) {
      const c = await sql<{
        points_balance: number;
      }>`select points_balance from customers where id = ${input.customer_id}::uuid`.execute(db());
      pointsBalance = c.rows[0]?.points_balance ?? null;
    }
    const out: CheckoutResult = {
      orderId: res.order_id,
      saleId: res.sale_id,
      folio: res.folio,
      totalCents: res.total_cents,
      paidCents: res.paid_cents ?? res.total_cents,
      changeCents: res.change_cents ?? 0,
      pointsEarned: res.points_earned ?? 0,
      pointsBalance,
      duplicate: res.duplicate,
      status: res.status ?? (res.sale_id ? "completed" : "new"),
    };
    return NextResponse.json(out, { status: res.duplicate ? 200 : 201 });
  } catch (e) {
    return dbErrorResponse(e, "pos_checkout");
  }
}
