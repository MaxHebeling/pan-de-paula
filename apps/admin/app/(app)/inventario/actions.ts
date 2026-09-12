"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { WASTE_REASONS } from "@pdp/domain";
import { requireSession } from "@/lib/auth";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { fail, isManager, str } from "@/lib/ops";
import type { FormState } from "@/components/ops/action-form";

const qtySchema = z.coerce.number().positive("La cantidad debe ser mayor a cero").max(99999);
const wasteReasonKeys = WASTE_REASONS.map((r) => r.key) as [string, ...string[]];

const wasteSchema = z.object({
  product_id: z.string().uuid("Elige un producto"),
  qty: qtySchema,
  reason: z.enum(wasteReasonKeys),
  note: z.string().trim().max(300).optional(),
});

/** Merma rápida → record_waste. */
export async function wasteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const parsed = wasteSchema.safeParse({
    product_id: str(form, "product_id"),
    qty: str(form, "qty"),
    reason: str(form, "reason"),
    note: str(form, "note") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const { product_id, qty, reason, note } = parsed.data;
  try {
    await withStaff(db(), session.staff.id, (trx) =>
      callFn<string>(trx, "record_waste", [product_id, qty, reason, note ?? null, null]),
    );
    return { ok: true, message: `Merma registrada: −${qty}` };
  } catch (e) {
    return fail(e, "record_waste");
  }
}

const adjustSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("waste"),
    product_id: z.string().uuid(),
    qty: qtySchema,
    reason: z.enum(wasteReasonKeys),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({
    mode: z.literal("correction"),
    product_id: z.string().uuid(),
    qty: qtySchema,
    direction: z.enum(["add", "remove"]),
    reason: z.enum(["difference", "error", "initial", "other"]),
    note: z.string().trim().max(300).optional(),
  }),
]);

/** Ajuste rápido desde la pestaña Stock: merma (record_waste) o corrección (record_stock_correction). */
export async function adjustAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const parsed = adjustSchema.safeParse({
    mode: str(form, "mode"),
    product_id: str(form, "product_id"),
    qty: str(form, "qty"),
    direction: str(form, "direction") || undefined,
    reason: str(form, "reason"),
    note: str(form, "note") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const d = parsed.data;
  try {
    await withStaff(db(), session.staff.id, async (trx) => {
      if (d.mode === "waste") {
        await callFn<string>(trx, "record_waste", [d.product_id, d.qty, d.reason, d.note ?? null, null]);
      } else {
        await callFn<number>(trx, "record_stock_correction", [
          d.product_id,
          d.direction === "add" ? d.qty : -d.qty,
          d.reason,
          d.note ?? null,
        ]);
      }
    });
    return {
      ok: true,
      message:
        d.mode === "waste"
          ? `Merma registrada: −${d.qty}`
          : `Corrección aplicada: ${d.direction === "add" ? "+" : "−"}${d.qty}`,
    };
  } catch (e) {
    return fail(e, "adjust");
  }
}

/** Conteo físico: paso 1, crear con esperado precargado. */
export async function createCountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const notes = str(form, "notes").slice(0, 300);
  let id: string;
  try {
    id = await withStaff(db(), session.staff.id, (trx) =>
      callFn<string>(trx, "create_stock_count", [notes || null]),
    );
  } catch (e) {
    return fail(e, "create_stock_count");
  }
  redirect(`/inventario?tab=conteo&conteo=${id}&paso=capturar`);
}

/** Conteo físico: paso 2, guardar cantidades contadas. */
export async function saveCountItemsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const countId = str(form, "stock_count_id");
  if (!z.string().uuid().safeParse(countId).success) return { error: "Conteo inválido" };
  const items: Array<{ product_id: string; counted: number; note: string | null }> = [];
  for (const [key, value] of form.entries()) {
    const m = /^counted_([0-9a-f-]{36})$/.exec(key);
    if (!m || typeof value !== "string") continue;
    const v = value.trim();
    if (v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `Cantidad inválida: "${v}"` };
    const note = str(form, `note_${m[1]}`).slice(0, 200);
    items.push({ product_id: m[1]!, counted: n, note: note || null });
  }
  try {
    await withStaff(db(), session.staff.id, async (trx) => {
      for (const it of items) {
        await callFn(trx, "set_stock_count_item", [countId, it.product_id, it.counted, it.note]);
      }
    });
  } catch (e) {
    return fail(e, "set_stock_count_item");
  }
  redirect(`/inventario?tab=conteo&conteo=${countId}&paso=revisar`);
}

/** Conteo físico: paso 3, aplicar correcciones (apply_stock_count). */
export async function applyCountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const countId = str(form, "stock_count_id");
  if (!z.string().uuid().safeParse(countId).success) return { error: "Conteo inválido" };
  let n: number;
  try {
    n = await withStaff(db(), session.staff.id, (trx) =>
      callFn<number>(trx, "apply_stock_count", [countId]),
    );
  } catch (e) {
    return fail(e, "apply_stock_count");
  }
  redirect(`/inventario?tab=conteo&aplicado=${n}`);
}

export async function discardCountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  const countId = str(form, "stock_count_id");
  if (!z.string().uuid().safeParse(countId).success) return { error: "Conteo inválido" };
  try {
    await withStaff(db(), session.staff.id, (trx) => callFn(trx, "discard_stock_count", [countId]));
  } catch (e) {
    return fail(e, "discard_stock_count");
  }
  redirect(`/inventario?tab=conteo&descartado=1`);
}

/** Reconstruye inventory_levels desde los movimientos (manager+). */
export async function rebuildLevelsAction(_prev: FormState, _form: FormData): Promise<FormState> {
  const session = await requireSession("inventory.write");
  if (!isManager(session)) return { error: "Solo gerencia puede reconstruir niveles" };
  try {
    await withStaff(db(), session.staff.id, async (trx) => {
      await sql`select rebuild_inventory_levels()`.execute(trx);
      await sql`insert into audit_logs(staff_id, action, entity) values (${session.staff.id}, 'REBUILD_LEVELS', 'inventory_levels')`.execute(
        trx,
      );
    });
    return { ok: true, message: "Niveles reconstruidos desde los movimientos" };
  } catch (e) {
    return fail(e, "rebuild_inventory_levels");
  }
}
