"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ORDER_STATUSES, PAYMENT_METHOD_LABELS, phoneMX, emailSchema } from "@pdp/domain";
import { isEmailConfigured, sendReceiptEmail } from "@pdp/integrations";
import { requireSession } from "@/lib/auth";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { fail, parseMoneyCents, str, type ActionResult } from "@/lib/ops";
import type { FormState } from "@/components/ops/action-form";
import { receiptData } from "@/lib/receipt";

const uuid = z.string().uuid();
const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as [string, ...string[]];
const providerFor = (method: string) =>
  method === "cash" ? "cash" : method === "mercadopago" ? "mercadopago" : "manual";

/** Cambia el estado del pedido (el servidor valida con change_order_status / order_transition_allowed). */
export async function changeStatusAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  const parsed = z
    .object({
      order_id: uuid,
      to_status: z.enum(ORDER_STATUSES),
      note: z.string().trim().max(300).optional(),
    })
    .safeParse({
      order_id: str(form, "order_id"),
      to_status: str(form, "to_status"),
      note: str(form, "note") || undefined,
    });
  if (!parsed.success) return { error: "Transición inválida" };
  const { order_id, to_status, note } = parsed.data;
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      callFn(trx, "change_order_status", [order_id, to_status, note ?? null]),
    );
    return { ok: true, message: "Estado actualizado" };
  } catch (e) {
    return fail(e, "change_order_status");
  }
}

/** Cancela con motivo obligatorio. Si ya hay venta, SQL lo rechaza (usar anulación/reembolso). */
export async function cancelOrderAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  const parsed = z
    .object({
      order_id: uuid,
      reason: z.string().trim().min(3, "Escribe el motivo de la cancelación").max(300),
    })
    .safeParse({ order_id: str(form, "order_id"), reason: str(form, "reason") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      callFn(trx, "change_order_status", [parsed.data.order_id, "cancelled", parsed.data.reason]),
    );
    return { ok: true, message: "Pedido cancelado" };
  } catch (e) {
    return fail(e, "cancel_order");
  }
}

/** Pago manual (efectivo, transferencia, terminal, otro) → record_payment; al completarse, finalize_sale descuenta stock y otorga puntos. */
export async function paymentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  const parsed = z
    .object({
      order_id: uuid,
      method: z.enum(METHODS),
      amount_cents: z.number().int().positive("El monto debe ser mayor a cero"),
      tendered_cents: z.number().int().positive().nullable(),
      reference: z.string().trim().max(80).optional(),
      idempotency_key: z.string().min(8).max(80),
    })
    .safeParse({
      order_id: str(form, "order_id"),
      method: str(form, "method"),
      amount_cents: parseMoneyCents(form.get("amount")),
      tendered_cents: parseMoneyCents(form.get("tendered")),
      reference: str(form, "reference") || undefined,
      idempotency_key: str(form, "idempotency_key"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const p = parsed.data;
  if (p.method === "points")
    return { error: "Los pagos con puntos se aplican como recompensa al crear el pedido" };
  try {
    const r = await withStaff(db(), session.staff.id, (trx) =>
      callFn<{
        payment_id: string;
        sale_id: string | null;
        change_cents: number;
        duplicate: boolean;
      }>(trx, "record_payment", [
        JSON.stringify({
          order_id: p.order_id,
          provider: providerFor(p.method),
          method: p.method,
          amount_cents: p.amount_cents,
          tendered_cents: p.method === "cash" ? p.tendered_cents : null,
          reference: p.reference,
          idempotency_key: p.idempotency_key,
        }),
      ]),
    );
    return {
      ok: true,
      message: r.duplicate
        ? "Este pago ya estaba registrado"
        : r.sale_id
          ? `Pago registrado · pedido pagado por completo${r.change_cents ? ` · cambio $${(r.change_cents / 100).toFixed(2)}` : ""}`
          : "Pago parcial registrado",
    };
  } catch (e) {
    return fail(e, "record_payment");
  }
}

/** Reembolso financiero sobre un pago (record_refund). Requiere pos.refund. */
export async function refundAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("pos.refund");
  const parsed = z
    .object({
      payment_id: uuid,
      amount_cents: z.number().int().positive("El monto debe ser mayor a cero"),
      reason: z.string().trim().min(3, "Escribe el motivo").max(300),
      idempotency_key: z.string().min(8).max(80),
    })
    .safeParse({
      payment_id: str(form, "payment_id"),
      amount_cents: parseMoneyCents(form.get("amount")),
      reason: str(form, "reason"),
      idempotency_key: str(form, "idempotency_key"),
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      callFn<string>(trx, "record_refund", [JSON.stringify(parsed.data)]),
    );
    return { ok: true, message: "Reembolso registrado" };
  } catch (e) {
    return fail(e, "record_refund");
  }
}

/** Devolución física (record_return), con reingreso opcional al inventario. Requiere pos.refund. */
export async function returnAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("pos.refund");
  const parsed = z
    .object({
      order_id: uuid,
      order_item_id: uuid,
      qty: z.coerce.number().positive("Cantidad inválida").max(9999),
      restock: z.boolean(),
      reason: z.string().trim().max(300).optional(),
    })
    .safeParse({
      order_id: str(form, "order_id"),
      order_item_id: str(form, "order_item_id"),
      qty: str(form, "qty"),
      restock: form.get("restock") === "on",
      reason: str(form, "reason") || undefined,
    });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const p = parsed.data;
  try {
    await withStaff(db(), session.staff.id, async (trx) => {
      const it = await sql<{ product_id: string | null; qty: string }>`
        select product_id, qty::text from order_items where id = ${p.order_item_id} and order_id = ${p.order_id}`.execute(
        trx,
      );
      const item = it.rows[0];
      if (!item)
        throw Object.assign(new Error("El producto no pertenece a este pedido"), { code: "P0001" });
      if (p.qty > Number(item.qty))
        throw Object.assign(new Error(`Solo se vendieron ${item.qty} unidades`), { code: "P0001" });
      await callFn<string>(trx, "record_return", [
        JSON.stringify({
          order_id: p.order_id,
          order_item_id: p.order_item_id,
          product_id: item.product_id,
          qty: p.qty,
          restock: p.restock,
          reason: p.reason,
        }),
      ]);
    });
    return {
      ok: true,
      message: p.restock ? "Devolución registrada y stock reingresado" : "Devolución registrada",
    };
  } catch (e) {
    return fail(e, "record_return");
  }
}

/** Notas internas del pedido (auditado por trigger). */
export async function notesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  const parsed = z
    .object({ order_id: uuid, internal_notes: z.string().trim().max(2000) })
    .safeParse({
      order_id: str(form, "order_id"),
      internal_notes: str(form, "internal_notes"),
    });
  if (!parsed.success) return { error: "Nota demasiado larga" };
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      sql`update orders set internal_notes = ${parsed.data.internal_notes || null} where id = ${parsed.data.order_id}`.execute(
        trx,
      ),
    );
    return { ok: true, message: "Notas guardadas" };
  } catch (e) {
    return fail(e, "internal_notes");
  }
}

/** Búsqueda de clientes para el pedido manual (código/QR/teléfono/email exacto o nombre parcial). */
export async function searchCustomersAction(
  q: string,
): Promise<
  ActionResult<
    Array<{
      id: string;
      full_name: string;
      phone: string | null;
      email: string | null;
      public_code: string;
    }>
  >
> {
  await requireSession("orders.write");
  const term = q.trim();
  if (term.length < 2) return { ok: true, data: [] };
  try {
    const r = await sql<{
      id: string;
      full_name: string;
      phone: string | null;
      email: string | null;
      public_code: string;
    }>`
      select id, full_name, phone::text, email::text, public_code from find_customer(${term})
      union
      (select id, full_name, phone::text, email::text, public_code from customers
        where deleted_at is null and merged_into_id is null
          and (full_name ilike '%' || ${term} || '%' or phone::text like '%' || ${term.replace(/[^0-9]/g, "") || " "} || '%')
        order by last_purchase_at desc nulls last limit 8)
      limit 8`.execute(db());
    return { ok: true, data: r.rows };
  } catch (e) {
    return fail(e, "search_customers");
  }
}

const newOrderSchema = z.object({
  channel: z.enum(["admin", "whatsapp", "instagram"]),
  fulfillment_type: z.enum(["pickup", "scheduled_pickup", "delivery", "preorder"]),
  scheduled_for: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  pickup_point_id: uuid.optional(),
  delivery_address: z
    .object({
      street: z.string().trim().min(3).max(200),
      neighborhood: z.string().trim().max(120).optional(),
      references_note: z.string().trim().max(300).optional(),
    })
    .optional(),
  customer_mode: z.enum(["none", "existing", "new"]),
  customer_id: uuid.optional(),
  customer_name: z.string().trim().max(120).optional(),
  customer_phone: phoneMX.optional(),
  customer_email: emailSchema.optional(),
  items: z
    .array(
      z.object({
        product_id: uuid,
        qty: z.number().positive().max(999),
        notes: z.string().trim().max(200).optional(),
      }),
    )
    .min(1, "Agrega al menos un producto")
    .max(50),
  coupon_code: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
  source_ref: z.string().trim().max(120).optional(),
  payment_method: z.enum(METHODS).optional(),
  payment_amount_cents: z.number().int().positive().nullable(),
  idempotency_key: z.string().min(8).max(80),
});

/** Pedido manual: (cliente nuevo →) create_order (→ record_payment) en una sola transacción. */
export async function createOrderAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  let items: unknown;
  try {
    items = JSON.parse(str(form, "items") || "[]");
  } catch {
    return { error: "Productos inválidos" };
  }
  const opt = (k: string) => str(form, k) || undefined;
  const parsed = newOrderSchema.safeParse({
    channel: str(form, "channel"),
    fulfillment_type: str(form, "fulfillment_type"),
    scheduled_for: opt("scheduled_for"),
    pickup_point_id: opt("pickup_point_id"),
    delivery_address:
      str(form, "fulfillment_type") === "delivery"
        ? {
            street: str(form, "street"),
            neighborhood: opt("neighborhood"),
            references_note: opt("references_note"),
          }
        : undefined,
    customer_mode: str(form, "customer_mode") || "none",
    customer_id: opt("customer_id"),
    customer_name: opt("customer_name"),
    customer_phone: opt("customer_phone"),
    customer_email: opt("customer_email"),
    items,
    coupon_code: opt("coupon_code"),
    notes: opt("notes"),
    source_ref: opt("source_ref"),
    payment_method: opt("payment_method"),
    payment_amount_cents: parseMoneyCents(form.get("payment_amount")),
    idempotency_key: str(form, "idempotency_key"),
  });
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { error: i ? `${i.path.join(".") || "Datos"}: ${i.message}` : "Datos inválidos" };
  }
  const p = parsed.data;
  if (p.customer_mode === "existing" && !p.customer_id) return { error: "Elige un cliente" };
  if (p.customer_mode === "new" && (!p.customer_name || (!p.customer_phone && !p.customer_email)))
    return { error: "Cliente nuevo: nombre y teléfono (o email) son obligatorios" };
  if (p.fulfillment_type !== "pickup" && !p.scheduled_for)
    return { error: "Indica la fecha y hora de entrega o retiro" };
  let orderId: string;
  try {
    orderId = await withStaff(db(), session.staff.id, async (trx) => {
      let customerId = p.customer_mode === "existing" ? p.customer_id : undefined;
      if (p.customer_mode === "new") {
        const c = await callFn<{ customer_id: string }>(trx, "register_customer", [
          JSON.stringify({
            full_name: p.customer_name,
            phone: p.customer_phone,
            email: p.customer_email,
            source: "admin",
          }),
        ]);
        customerId = c.customer_id;
      }
      let scheduled: string | null = null;
      if (p.scheduled_for) {
        const r = await sql<{ ts: string }>`
          select ((${p.scheduled_for.replace("T", " ")}::timestamp) at time zone (select timezone from business_settings where id = 1))::text as ts`.execute(
          trx,
        );
        scheduled = r.rows[0]!.ts;
      }
      const id = await callFn<string>(trx, "create_order", [
        JSON.stringify({
          channel: p.channel,
          fulfillment_type: p.fulfillment_type,
          customer_id: customerId,
          customer_name: p.customer_mode === "none" ? p.customer_name : undefined,
          customer_phone: p.customer_mode === "none" ? p.customer_phone : undefined,
          customer_email: p.customer_mode === "none" ? p.customer_email : undefined,
          pickup_point_id: p.fulfillment_type === "delivery" ? undefined : p.pickup_point_id,
          delivery_address: p.delivery_address,
          scheduled_for: scheduled,
          notes: p.notes,
          source_ref: p.source_ref,
          coupon_code: p.coupon_code,
          items: p.items,
          idempotency_key: p.idempotency_key,
        }),
      ]);
      if (p.payment_method && p.payment_amount_cents && p.payment_method !== "points") {
        await callFn(trx, "record_payment", [
          JSON.stringify({
            order_id: id,
            provider: providerFor(p.payment_method),
            method: p.payment_method,
            amount_cents: p.payment_amount_cents,
            idempotency_key: `${p.idempotency_key}-pay`,
          }),
        ]);
      } else {
        await callFn(trx, "change_order_status", [
          id,
          "confirmed",
          "Pedido capturado por " + session.staff.fullName,
        ]);
      }
      return id;
    });
  } catch (e) {
    return fail(e, "create_order");
  }
  redirect(`/pedidos/${orderId}`);
}

/** Envía el comprobante por email si el flag `email_receipts` está activo y hay proveedor configurado. */
export async function sendReceiptAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("orders.write");
  const parsed = z
    .object({ order_id: uuid, to: emailSchema })
    .safeParse({ order_id: str(form, "order_id"), to: str(form, "to") });
  if (!parsed.success) return { error: "Escribe un email válido" };
  const d = db();
  const flag = await sql<{
    enabled: boolean;
  }>`select enabled from feature_flags where key = 'email_receipts'`.execute(d);
  if (!flag.rows[0]?.enabled)
    return {
      error: "El envío de comprobantes por email está desactivado (feature flag email_receipts)",
    };
  if (!isEmailConfigured())
    return { error: "No hay proveedor de email configurado (RESEND_API_KEY / EMAIL_FROM)" };
  const data = await receiptData(parsed.data.order_id);
  if (!data) return { error: "Pedido no encontrado" };
  let result: { sent: boolean; error?: string; skipped?: string } | null = null;
  let errorMessage: string | null = null;
  try {
    result = await sendReceiptEmail(parsed.data.to, data);
    if (!result.sent) errorMessage = result.error ?? result.skipped ?? "no enviado";
  } catch (e) {
    errorMessage = (e as Error).message;
    console.error("[recibo] sendReceiptEmail falló", {
      order_id: parsed.data.order_id,
      error: errorMessage,
    });
  }
  await withStaff(d, session.staff.id, (trx) =>
    sql`insert into receipts(order_id, channel, destination, status, error)
        values (${parsed.data.order_id}, 'email', ${parsed.data.to}, ${errorMessage ? "failed" : "sent"}, ${errorMessage})`.execute(
      trx,
    ),
  );
  return errorMessage
    ? { error: `No se pudo enviar: ${errorMessage}` }
    : { ok: true, message: `Comprobante enviado a ${parsed.data.to}` };
}
