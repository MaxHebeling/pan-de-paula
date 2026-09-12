"use server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { db, sql, callFn, withStaff } from "@/lib/db";
import { fail, TODAY, type ActionResult } from "@/lib/ops";

const produceSchema = z.object({
  product_id: z.string().uuid(),
  qty: z.number().positive().max(9999),
  consume_ingredients: z.boolean(),
  notes: z.string().trim().max(200).optional(),
});

export type ProduceResult = {
  batch_id: string;
  lot_code: string;
  produced_today: number;
  on_hand: number;
  ingredients_consumed: boolean;
  created_at: string;
};

async function productTotals(productId: string) {
  const r = await sql<{ produced_today: string; on_hand: string }>`
    select coalesce((select sum(b.qty) from production_batches b
                     where b.product_id = ${productId} and b.undone_at is null
                       and (b.produced_at at time zone (select timezone from business_settings where id = 1))::date = ${TODAY}), 0)::text as produced_today,
           coalesce((select on_hand from inventory_levels where product_id = ${productId}), 0)::text as on_hand`.execute(
    db(),
  );
  const row = r.rows[0]!;
  return { produced_today: Number(row.produced_today), on_hand: Number(row.on_hand) };
}

/** Registra un lote de producción (record_production). Un toque = un lote. */
export async function produceAction(input: unknown): Promise<ActionResult<ProduceResult>> {
  const session = await requireSession("production.write");
  const parsed = produceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Cantidad o producto inválidos" };
  const { product_id, qty, consume_ingredients, notes } = parsed.data;
  try {
    const batchId = await withStaff(db(), session.staff.id, (trx) =>
      callFn<string>(trx, "record_production", [
        product_id,
        qty,
        notes ?? null,
        consume_ingredients,
        null,
      ]),
    );
    const b = await sql<{ lot_code: string; ingredients_consumed: boolean; created_at: Date }>`
      select lot_code, ingredients_consumed, created_at from production_batches where id = ${batchId}`.execute(
      db(),
    );
    const totals = await productTotals(product_id);
    return {
      ok: true,
      data: {
        batch_id: batchId,
        lot_code: b.rows[0]!.lot_code,
        ingredients_consumed: b.rows[0]!.ingredients_consumed,
        created_at: new Date(b.rows[0]!.created_at).toISOString(),
        ...totals,
      },
    };
  } catch (e) {
    return fail(e, "record_production");
  }
}

/** Deshace el último lote (ventana de 2 minutos, validada en SQL). */
export async function undoProductionAction(
  input: unknown,
): Promise<ActionResult<{ produced_today: number; on_hand: number }>> {
  const session = await requireSession("production.write");
  const parsed = z.object({ batch_id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Lote inválido" };
  try {
    const productId = await withStaff(db(), session.staff.id, async (trx) => {
      await callFn<number>(trx, "undo_production", [parsed.data.batch_id, "deshacer"]);
      const r = await sql<{ product_id: string }>`
        select product_id from production_batches where id = ${parsed.data.batch_id}`.execute(trx);
      return r.rows[0]!.product_id;
    });
    return { ok: true, data: await productTotals(productId), message: "Lote deshecho" };
  } catch (e) {
    return fail(e, "undo_production");
  }
}
