"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { newIdempotencyKey, toCents } from "@pdp/domain";
import { requireSession } from "@/lib/auth";
import { db, callFn, withStaff, dbErrorMessage } from "@/lib/db";

export type ActionState = { ok?: boolean; error?: string; message?: string };

const voidSchema = z.object({
  sale_id: z.string().uuid(),
  reason: z.string().trim().min(3, "Escribe el motivo (mínimo 3 caracteres)").max(200),
  confirm: z.literal("on", { message: "Confirma la anulación" }),
});

/** Anula una venta completa: revierte stock, puntos, cupón y marca pagos cancelados (void_sale). */
export async function voidSaleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("pos.refund");
  const parsed = voidSchema.safeParse({
    sale_id: form.get("sale_id"),
    reason: form.get("reason"),
    confirm: form.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) => callFn(trx, "void_sale", [parsed.data.sale_id, parsed.data.reason]));
  } catch (e) {
    const m = dbErrorMessage(e);
    console.error("[ventas] void_sale", m);
    return { error: m.message };
  }
  revalidatePath("/pos/ventas");
  return { ok: true, message: "Venta anulada" };
}

const refundSchema = z.object({
  payment_id: z.string().uuid(),
  amount: z.string().trim().min(1, "Escribe el monto"),
  reason: z.string().trim().min(3, "Escribe el motivo (mínimo 3 caracteres)").max(200),
  confirm: z.literal("on", { message: "Confirma el reembolso" }),
});

/** Reembolso parcial o total de un pago (record_refund). No regresa stock: eso es una devolución aparte. */
export async function refundPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("pos.refund");
  const parsed = refundSchema.safeParse({
    payment_id: form.get("payment_id"),
    amount: form.get("amount"),
    reason: form.get("reason"),
    confirm: form.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  let cents: number;
  try {
    cents = toCents(parsed.data.amount);
  } catch {
    return { error: "Monto inválido" };
  }
  if (!Number.isInteger(cents) || cents <= 0) return { error: "El monto debe ser mayor a $0" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({
          payment_id: parsed.data.payment_id,
          amount_cents: cents,
          reason: parsed.data.reason,
          idempotency_key: newIdempotencyKey("refund"),
        }),
      ]),
    );
  } catch (e) {
    const m = dbErrorMessage(e);
    console.error("[ventas] record_refund", m);
    return { error: m.message };
  }
  revalidatePath("/pos/ventas");
  return { ok: true, message: "Reembolso registrado" };
}
