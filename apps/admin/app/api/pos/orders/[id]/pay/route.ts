import { NextResponse } from "next/server";
import { z } from "zod";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { apiSession, dbErrorResponse, getOpenRegister, jsonError, readJson } from "@/lib/pos";

export const dynamic = "force-dynamic";

const pago = z.object({
  provider: z.enum(["cash", "manual"]),
  method: z.enum(["cash", "card_terminal", "transfer", "other"]),
  amount_cents: z.number().int().positive(),
  tendered_cents: z.number().int().positive().optional(),
  reference: z.string().trim().max(80).optional(),
});

const schema = z.object({
  idempotency_key: z.string().min(8).max(80),
  payments: z.array(pago).min(1).max(6),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cobra el saldo de un pedido YA GUARDADO, desde la pantalla de caja del punto de venta.
 *
 * No es un segundo motor de cobros: cada pago lo registra `record_payment`, el mismo que usa
 * `pos_checkout` y el mismo que usa el formulario del detalle del pedido. De ahí vienen gratis la
 * idempotencia (por `idempotency_key` y por `provider+external_id`), el bloqueo de la fila del
 * pedido con `for update`, el rechazo de pedidos cancelados, el tope del total, la acumulación en
 * `paid_cents` y el cierre de la venta con `finalize_sale` SOLO cuando el saldo queda cubierto.
 *
 * Diferencia con `/api/pos/checkout`: aquí NO se crea ningún pedido. El pedido existe, tiene su
 * folio, sus renglones con los precios acordados y sus anticipos; esto solo le aplica dinero.
 *
 * Mercado Pago no pasa por aquí, igual que en `pos_checkout`: se inicia en
 * `/api/pos/payments/mercadopago` y lo confirma el webhook. Un pago MP "aprobado" desde el cliente
 * sería dinero que nadie recibió.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await apiSession("pos.sell");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(400, "Pedido inválido", "VALIDATION");

  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success)
    return jsonError(400, parsed.error.issues[0]?.message ?? "Datos inválidos", "VALIDATION");
  const { idempotency_key, payments } = parsed.data;

  // Estado vigente del pedido ANTES de cobrar. `record_payment` lo vuelve a comprobar con la fila
  // bloqueada —es él quien manda—, pero así el operador recibe un error claro en lugar de una
  // excepción de la base.
  const o = (
    await sql<{
      folio: string;
      status: string;
      total_cents: number;
      paid_cents: number;
    }>`select folio, status::text as status, total_cents, paid_cents
         from orders where id = ${id}::uuid`.execute(db())
  ).rows[0];
  if (!o) return jsonError(404, "El pedido no existe", "NOT_FOUND");
  if (o.status === "cancelled" || o.status === "refunded")
    return jsonError(409, `El pedido está ${o.status} y no se puede cobrar`, "ORDER_NOT_PAYABLE");

  const saldo = o.total_cents - o.paid_cents;
  if (saldo <= 0) return jsonError(409, "Este pedido ya está pagado", "ALREADY_PAID");

  const suma = payments.reduce((a, p) => a + p.amount_cents, 0);
  if (suma > saldo)
    return jsonError(
      409,
      `El cobro (${suma}) excede el saldo pendiente (${saldo})`,
      "EXCEEDS_BALANCE",
    );

  // El efectivo tiene que caer en una caja abierta: si no, el corte sale con una diferencia que
  // nadie puede explicar. Los demás medios se permiten con la caja cerrada (p. ej. una entrega a
  // domicilio cobrada por transferencia), igual que en el detalle del pedido.
  const register = await getOpenRegister();
  if (payments.some((p) => p.method === "cash") && !register)
    return jsonError(
      409,
      "La caja está cerrada. Ábrela para cobrar en efectivo.",
      "REGISTER_CLOSED",
    );

  try {
    let saleId: string | null = null;
    let cambio = 0;
    let duplicado = true;
    for (const [i, p] of payments.entries()) {
      /*
       * Una clave derivada por pago, con el mismo criterio que `pos_checkout`: incluye el índice,
       * el método y el importe. Así un reintento de la MISMA operación recupera los pagos ya
       * registrados en lugar de cobrar otra vez, y un pago distinto no colisiona con el anterior.
       */
      const clave = `${idempotency_key}:${i}:${p.method}:${p.amount_cents}`;
      const r = await withStaff(db(), auth.session.staff.id, (trx) =>
        callFn<{
          payment_id: string;
          sale_id: string | null;
          change_cents: number;
          duplicate: boolean;
        }>(trx, "record_payment", [
          JSON.stringify({
            order_id: id,
            provider: p.provider,
            method: p.method,
            amount_cents: p.amount_cents,
            tendered_cents: p.method === "cash" ? (p.tendered_cents ?? null) : null,
            reference: p.reference,
            idempotency_key: clave,
            register_session_id: register?.id ?? null,
          }),
        ]),
      );
      cambio += r.change_cents ?? 0;
      if (r.sale_id) saleId = r.sale_id;
      if (!r.duplicate) duplicado = false;
    }

    const after = (
      await sql<{
        total_cents: number;
        paid_cents: number;
        payment_status: string;
        folio: string;
      }>`select total_cents, paid_cents, payment_status::text as payment_status, folio
           from orders where id = ${id}::uuid`.execute(db())
    ).rows[0]!;

    return NextResponse.json(
      {
        orderId: id,
        saleId,
        folio: after.folio,
        totalCents: after.total_cents,
        paidCents: after.paid_cents,
        balanceCents: Math.max(0, after.total_cents - after.paid_cents),
        changeCents: cambio,
        paymentStatus: after.payment_status,
        duplicate: duplicado,
      },
      { status: duplicado ? 200 : 201 },
    );
  } catch (e) {
    return dbErrorResponse(e, "cobro_pedido");
  }
}
