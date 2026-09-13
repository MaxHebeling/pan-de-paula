"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, sql, withStaff, callFn } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { cents, failure, num, str, strOrNull, zCents, zId, zodMessage } from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";
import { loadBreakdown } from "@/lib/costing";
import { normalizeBreakdown } from "@/components/catalog/costing-types";

const itemSchema = z.object({
  ingredient_id: zId,
  qty: z
    .number({ error: "Cantidad inválida" })
    .positive("Cada línea necesita cantidad mayor a cero")
    .max(1_000_000_000),
  note: z.string().trim().max(120).nullable().optional(),
});

const recipeSchema = z.object({
  yield_qty: z
    .number({ error: "Escribe el rendimiento" })
    .positive("El rendimiento debe ser mayor a cero")
    .max(1_000_000),
  yield_label: z.string().trim().max(60).nullable(),
  labor_cents: zCents,
  overhead_cents: zCents,
  notes: z.string().trim().max(1000).nullable(),
  items: z.array(itemSchema).max(100),
  waste_bps: z
    .number()
    .int()
    .min(0, "La merma no puede ser negativa")
    .max(10000, "Merma máxima 100%")
    .nullable(),
  target_margin_bps: z
    .number()
    .int()
    .min(0, "El margen objetivo no puede ser negativo")
    .max(9900, "El margen objetivo debe ser menor a 99%")
    .nullable(),
  labor_minutes: z.number().min(0, "Los minutos no pueden ser negativos").max(100_000).nullable(),
});

/** "12.5" (porcentaje) → 1250 bps; vacío → null. NaN si es inválido. */
function bps(form: FormData, key: string): number | null {
  const n = num(form, key);
  if (n === undefined) return null;
  return Number.isNaN(n) ? Number.NaN : Math.round(n * 100);
}

function revalidate(productId: string) {
  revalidatePath("/recetas");
  revalidatePath("/recetas/hoja");
  revalidatePath(`/recetas/${productId}`);
  revalidatePath("/productos");
  revalidatePath(`/productos/${productId}`);
  revalidatePath("/precios");
  revalidatePath(`/precios/${productId}`);
  revalidatePath("/ingredientes");
}

export async function saveRecipe(
  productId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
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
    waste_bps: bps(form, "waste_pct"),
    target_margin_bps: bps(form, "target_margin_pct"),
    labor_minutes: num(form, "labor_minutes") ?? null,
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const seen = new Set<string>();
  for (const it of parsed.data.items) {
    if (seen.has(it.ingredient_id))
      return { error: "Un ingrediente aparece dos veces en la receta; combina las líneas." };
    seen.add(it.ingredient_id);
  }
  let cost: number | null = null;
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "upsert_recipe_v2", [
        productId,
        parsed.data.yield_qty,
        parsed.data.yield_label,
        parsed.data.labor_cents,
        parsed.data.overhead_cents,
        parsed.data.notes,
        JSON.stringify(parsed.data.items),
        parsed.data.waste_bps,
        parsed.data.target_margin_bps,
        parsed.data.labor_minutes,
      ]),
    );
    cost = await callFn<number | null>(db(), "product_cost_cents", [productId]);
  } catch (e) {
    return failure("recetas.save", e);
  }
  revalidate(productId);
  return {
    ok:
      cost === null
        ? "Receta guardada."
        : `Receta guardada. Costo por pieza: $${(cost / 100).toFixed(2)}.`,
    data: cost === null ? undefined : { cost_cents: String(cost) },
  };
}

export async function deleteRecipe(productId: string): Promise<void> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(productId).success) return;
  await withStaff(db(), s.staff.id, (trx) =>
    trx.deleteFrom("recipes").where("product_id", "=", productId).execute(),
  );
  revalidate(productId);
}

// ── Edición celda por celda (hoja de costos / editor) ────────────────────────
const patchSchema = z
  .object({
    yield_qty: z
      .number({ error: "Rendimiento inválido" })
      .positive("El rendimiento debe ser mayor a cero")
      .max(1_000_000)
      .optional(),
    labor_cents: zCents.optional(),
    overhead_cents: zCents.optional(),
    labor_minutes: z.number().min(0, "Minutos inválidos").max(100_000).nullable().optional(),
    waste_bps: z
      .number()
      .int()
      .min(0, "Merma inválida")
      .max(10000, "Merma máxima 100%")
      .nullable()
      .optional(),
    target_margin_bps: z
      .number()
      .int()
      .min(0, "Margen inválido")
      .max(9900, "El margen objetivo debe ser menor a 99%")
      .nullable()
      .optional(),
  })
  .strict();

/** Guarda un subconjunto de parámetros de la receta (crea la receta si no existe) y devuelve el desglose recalculado por SQL. */
export async function updateRecipeParams(productId: string, patch: unknown): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  if (Object.keys(parsed.data).length === 0) return { error: "Nada que guardar" };
  try {
    const raw = await withStaff(db(), s.staff.id, (trx) =>
      callFn<unknown>(trx, "update_recipe_params", [productId, JSON.stringify(parsed.data)]),
    );
    revalidate(productId);
    return { ok: "Guardado.", data: { breakdown: normalizeBreakdown(raw) } };
  } catch (e) {
    return failure("recetas.params", e);
  }
}

const channelSchema = z.enum(["all", "pos", "web"], { error: "Canal inválido" });

/** Nuevo precio regular desde una celda (nunca edita el histórico) y desglose recalculado. */
export async function setSheetPrice(
  productId: string,
  channel: "all" | "pos" | "web",
  priceCents: unknown,
): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  const ch = channelSchema.safeParse(channel);
  const price = zCents.safeParse(priceCents);
  if (!ch.success) return { error: zodMessage(ch.error) };
  if (!price.success) return { error: zodMessage(price.error) };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "set_regular_price", [productId, ch.data, price.data, "Hoja de costos"]),
    );
    const b = await loadBreakdown(productId);
    revalidate(productId);
    return { ok: "Precio regular actualizado.", data: b ? { breakdown: b } : undefined };
  } catch (e) {
    return failure("recetas.sheet_price", e);
  }
}

/**
 * Crea un precio regular igual al sugerido. Se fija en 'all' y, si POS o web tienen un regular propio
 * vigente (que ganaría al de 'all'), también en ese canal, para que el precio vigente sea el sugerido.
 */
export async function applySuggestedPrice(productId: string): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  try {
    const before = await loadBreakdown(productId);
    const suggested = before?.suggested_price_cents ?? null;
    if (!before || suggested === null)
      return { error: "Sin costo por pieza: no hay precio sugerido que aplicar." };
    const label = `Precio sugerido (margen ${(before.target_margin_bps / 100).toFixed(0)}%)`;
    await withStaff(db(), s.staff.id, async (trx) => {
      await callFn(trx, "set_regular_price", [productId, "all", suggested, label]);
      const specific = await sql<{ channel: "pos" | "web" }>`
        select distinct channel from product_prices
        where product_id = ${productId} and kind = 'regular' and channel in ('pos', 'web')
          and valid_from <= now() and (valid_to is null or valid_to > now())`.execute(trx);
      for (const r of specific.rows)
        await callFn(trx, "set_regular_price", [productId, r.channel, suggested, label]);
    });
    const b = await loadBreakdown(productId);
    revalidate(productId);
    return {
      ok: `Precio regular fijado en $${(suggested / 100).toFixed(2)}.`,
      data: b ? { breakdown: b } : undefined,
    };
  } catch (e) {
    return failure("recetas.apply_suggested", e);
  }
}
