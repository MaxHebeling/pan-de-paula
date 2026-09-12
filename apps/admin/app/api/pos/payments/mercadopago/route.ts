import { NextResponse } from "next/server";
import { z } from "zod";
import { posCheckoutSchema } from "@pdp/domain";
import {
  NotConfiguredError,
  createPointOrder,
  createQrOrder,
  isMercadoPagoConfigured,
} from "@pdp/integrations";
import { hasPermission } from "@/lib/auth";
import { db, sql, callFn, withStaff } from "@/lib/db";
import {
  apiSession,
  dbErrorResponse,
  getFlags,
  getOpenRegister,
  jsonError,
  readJson,
} from "@/lib/pos";
import type { MpStartResult } from "@/components/pos/types";

export const dynamic = "force-dynamic";

const schema = posCheckoutSchema.omit({ payments: true }).extend({
  kind: z.enum(["point", "qr"]),
});

/** Traduce fallas del adaptador de Mercado Pago a un mensaje claro para la cajera. */
function mpErrorResponse(e: unknown, kind: "point" | "qr") {
  const label = kind === "point" ? "la terminal Point" : "el QR";
  if (e instanceof NotConfiguredError) {
    console.error("[pos] Mercado Pago no configurado", e.envVars);
    return jsonError(
      503,
      `Mercado Pago no está configurado (${e.envVars.join(", ")}). Cobra con otro método.`,
      "MP_NOT_CONFIGURED",
    );
  }
  const msg = (e as Error)?.message ?? "";
  console.error(`[pos] error al crear cobro MP ${kind}`, msg);
  if (/pendiente de implementaci/i.test(msg)) {
    return jsonError(
      503,
      `El cobro con ${label} de Mercado Pago aún no está disponible en esta versión. Cobra con otro método.`,
      "MP_NOT_IMPLEMENTED",
    );
  }
  return jsonError(
    502,
    `No se pudo iniciar el cobro con ${label}. Intenta de nuevo o cobra con otro método.`,
    "MP_ERROR",
  );
}

/**
 * Inicia un cobro Point/QR: crea el pedido (precios del servidor), pide la orden a Mercado Pago y registra
 * un pago `pending`. La venta se concreta SOLO cuando el webhook aplica el pago aprobado (apply_mercadopago_payment).
 * Si Mercado Pago falla, el pedido se cancela y no queda nada pendiente.
 */
export async function POST(req: Request) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success)
    return jsonError(400, parsed.error.issues[0]?.message ?? "Datos inválidos", "VALIDATION");
  const input = parsed.data;
  if (
    input.items.some((i) => (i.discount_cents ?? 0) > 0) &&
    !hasPermission(auth.session, "pos.refund")
  ) {
    return jsonError(
      403,
      "Los descuentos por línea requieren permiso de gerente",
      "DISCOUNT_FORBIDDEN",
    );
  }
  const flags = await getFlags(["mercadopago_point", "mercadopago_qr"] as const);
  if (input.kind === "point" && !flags.mercadopago_point)
    return jsonError(409, "El cobro con terminal Point está desactivado", "FLAG_OFF");
  if (input.kind === "qr" && !flags.mercadopago_qr)
    return jsonError(409, "El cobro con QR de Mercado Pago está desactivado", "FLAG_OFF");
  if (!isMercadoPagoConfigured())
    return jsonError(
      503,
      "Mercado Pago no está configurado (MERCADOPAGO_ACCESS_TOKEN). Cobra con otro método.",
      "MP_NOT_CONFIGURED",
    );
  const deviceId = process.env.MERCADOPAGO_POINT_DEVICE_ID;
  if (input.kind === "point" && !deviceId)
    return jsonError(
      503,
      "Falta configurar la terminal (MERCADOPAGO_POINT_DEVICE_ID).",
      "MP_NOT_CONFIGURED",
    );

  const register = await getOpenRegister();
  const staffId = auth.session.staff.id;
  const { kind, ...orderInput } = input;

  // 1) Pedido (idempotente por idempotency_key). Si ya existe y ya tiene pago MP pendiente, reutilizamos.
  let orderId: string;
  let folio: string;
  let totalCents: number;
  try {
    orderId = await withStaff(db(), staffId, (trx) =>
      callFn<string>(trx, "create_order", [
        JSON.stringify({
          ...orderInput,
          channel: "pos",
          register_session_id: register?.id ?? null,
        }),
      ]),
    );
    const o = await sql<{
      folio: string;
      total_cents: number;
      status: string;
      sale_id: string | null;
    }>`select o.folio, o.total_cents, o.status, s.id as sale_id from orders o left join sales s on s.order_id = o.id where o.id = ${orderId}::uuid`.execute(
      db(),
    );
    const row = o.rows[0]!;
    folio = row.folio;
    totalCents = row.total_cents;
    if (row.sale_id) {
      return NextResponse.json({ orderId, folio, totalCents, mpOrderId: "", alreadyPaid: true });
    }
    if (row.status === "cancelled") {
      return jsonError(
        409,
        "Este intento de cobro ya fue cancelado. Inicia uno nuevo.",
        "ORDER_CANCELLED",
      );
    }
    const existing = await sql<{
      external_id: string | null;
      metadata: { qr_data?: string } | null;
    }>`select external_id, metadata from payments where order_id = ${orderId}::uuid and provider = 'mercadopago' and status = 'pending' order by created_at desc limit 1`.execute(
      db(),
    );
    const prev = existing.rows[0];
    if (prev?.external_id) {
      const out: MpStartResult = {
        orderId,
        folio,
        totalCents,
        mpOrderId: prev.external_id,
        qrData: prev.metadata?.qr_data,
      };
      return NextResponse.json(out);
    }
    if (totalCents <= 0) {
      return jsonError(
        409,
        "El total es $0: cobra sin Mercado Pago (la recompensa cubre todo).",
        "ZERO_TOTAL",
      );
    }
  } catch (e) {
    return dbErrorResponse(e, "create_order (MP)");
  }

  // 2) Orden en Mercado Pago (fuera de la transacción; si falla, cancelamos el pedido).
  let mpOrderId: string;
  let qrData: string | undefined;
  try {
    const description = `El Pan de Paula ${folio}`;
    if (kind === "point") {
      const r = await createPointOrder({
        deviceId: deviceId!,
        amountCents: totalCents,
        externalReference: orderId,
        description,
      });
      mpOrderId = r.orderId;
    } else {
      const items = await sql<{
        product_name: string;
        qty: string | number;
        unit_price_cents: number;
      }>`
        select product_name, qty, unit_price_cents from order_items where order_id = ${orderId}::uuid order by sort_order`.execute(
        db(),
      );
      const r = await createQrOrder({
        amountCents: totalCents,
        externalReference: orderId,
        description,
        items: items.rows.map((i) => ({
          title: i.product_name,
          quantity: Number(i.qty),
          unitPriceCents: i.unit_price_cents,
        })),
      });
      mpOrderId = r.orderId;
      qrData = r.qrData;
    }
  } catch (e) {
    try {
      await withStaff(db(), staffId, (trx) =>
        callFn(trx, "cancel_pending_pos_order", [orderId, "Mercado Pago no disponible"]),
      );
    } catch (cancelErr) {
      console.error(
        "[pos] no se pudo cancelar pedido tras falla MP",
        orderId,
        (cancelErr as Error).message,
      );
    }
    return mpErrorResponse(e, kind);
  }

  // 3) Pago pendiente ligado a la orden MP. El webhook lo confirmará (o lo marcará fallido).
  try {
    await withStaff(db(), staffId, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: orderId,
          provider: "mercadopago",
          method: "mercadopago",
          amount_cents: totalCents,
          status: "pending",
          external_id: mpOrderId,
          external_status: "created",
          register_session_id: register?.id ?? null,
          idempotency_key: `${orderInput.idempotency_key}:mp:${kind}`,
          metadata: { kind, mp_order_id: mpOrderId, ...(qrData ? { qr_data: qrData } : {}) },
        }),
      ]),
    );
  } catch (e) {
    return dbErrorResponse(e, "record_payment pending (MP)");
  }
  const out: MpStartResult = { orderId, folio, totalCents, mpOrderId, qrData };
  return NextResponse.json(out, { status: 201 });
}
