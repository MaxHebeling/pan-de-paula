import { NextResponse } from "next/server";
import { z } from "zod";
import { db, callFn, withStaff } from "@/lib/db";
import { apiSession, dbErrorResponse, jsonError, readJson } from "@/lib/pos";

export const dynamic = "force-dynamic";

const renglon = z.object({
  product_id: z.string().uuid(),
  qty: z.number().positive().max(9999),
  notes: z.string().trim().max(200).optional(),
});

const schema = z.object({
  idempotency_key: z.string().min(8).max(80),
  items: z.array(renglon).min(1).max(40),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Agrega productos a un pedido que todavía no se ha cobrado.
 *
 * El caso: la persona viene a retirar su pedido y en el mostrador pide dos conchas más. Sin esto el
 * mostrador tenía que cobrar aparte y entregar dos tickets.
 *
 * Toda la lógica vive en `add_order_items` (migración 0084), no aquí: de ahí vienen la
 * idempotencia, el bloqueo de la fila del pedido, el rechazo de un pedido YA COBRADO —donde la
 * venta existe, el total está congelado y el stock descontado—, el precio del canal del pedido y
 * el descuento que no se recalcula. Esta ruta solo valida la forma de la petición y traduce.
 *
 * Permiso `orders.write`: agregar renglones modifica el pedido y su total. Lo tienen todos los
 * roles de mostrador (cajera, ventas, gerencia y arriba); quedan fuera marketing y producción,
 * que no deben tocar pedidos.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await apiSession("orders.write");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(400, "Pedido inválido", "VALIDATION");

  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success)
    return jsonError(400, parsed.error.issues[0]?.message ?? "Datos inválidos", "VALIDATION");

  try {
    const r = await withStaff(db(), auth.session.staff.id, (trx) =>
      callFn<{
        order_id: string;
        folio: string;
        added: { product_name: string; qty: number; total_cents: number }[];
        subtotal_cents: number;
        discount_cents: number;
        tax_cents: number;
        total_cents: number;
        paid_cents: number;
        balance_cents: number;
        payment_status: string;
        duplicate: boolean;
      }>(trx, "add_order_items", [
        JSON.stringify({
          order_id: id,
          idempotency_key: parsed.data.idempotency_key,
          items: parsed.data.items,
        }),
      ]),
    );
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return dbErrorResponse(e, "agregar_productos_pedido");
  }
}
