"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, withStaff, callFn } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { cents, failure, num, str, strOrNull, zCents, zId, zodMessage } from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";

const itemSchema = z.object({
  ingredient_id: zId,
  qty: z.number({ error: "Cantidad inválida" }).positive("Cada línea necesita cantidad mayor a cero").max(1_000_000_000),
  note: z.string().trim().max(120).nullable().optional(),
});

const recipeSchema = z.object({
  yield_qty: z.number({ error: "Escribe el rendimiento" }).positive("El rendimiento debe ser mayor a cero").max(1_000_000),
  yield_label: z.string().trim().max(60).nullable(),
  labor_cents: zCents,
  overhead_cents: zCents,
  notes: z.string().trim().max(1000).nullable(),
  items: z.array(itemSchema).max(100),
});

function revalidate(productId: string) {
  revalidatePath("/recetas");
  revalidatePath(`/recetas/${productId}`);
  revalidatePath("/productos");
  revalidatePath(`/productos/${productId}`);
  revalidatePath("/ingredientes");
}

export async function saveRecipe(productId: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  let itemsRaw: unknown = [];
  try {
    itemsRaw = JSON.parse(str(form, "items") ?? "[]");
  } catch {
    return { error: "Las líneas de la receta no son válidas" };
  }
  const parsed = recipeSchema.safeParse({
    yield_qty: num(form, "yield_qty"),
    yield_label: strOrNull(form, "yield_label"),
    labor_cents: cents(form, "labor") ?? 0,
    overhead_cents: cents(form, "overhead") ?? 0,
    notes: strOrNull(form, "notes"),
    items: itemsRaw,
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const seen = new Set<string>();
  for (const it of parsed.data.items) {
    if (seen.has(it.ingredient_id)) return { error: "Un ingrediente aparece dos veces en la receta; combina las líneas." };
    seen.add(it.ingredient_id);
  }
  let cost: number | null = null;
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "upsert_recipe", [
        productId,
        parsed.data.yield_qty,
        parsed.data.yield_label,
        parsed.data.labor_cents,
        parsed.data.overhead_cents,
        parsed.data.notes,
        JSON.stringify(parsed.data.items),
      ]),
    );
    cost = await callFn<number | null>(db(), "product_cost_cents", [productId]);
  } catch (e) {
    return failure("recetas.save", e);
  }
  revalidate(productId);
  return {
    ok: cost === null ? "Receta guardada." : `Receta guardada. Costo por pieza: $${(cost / 100).toFixed(2)}.`,
    data: cost === null ? undefined : { cost_cents: String(cost) },
  };
}

export async function deleteRecipe(productId: string): Promise<void> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(productId).success) return;
  await withStaff(db(), s.staff.id, (trx) => trx.deleteFrom("recipes").where("product_id", "=", productId).execute());
  revalidate(productId);
}
