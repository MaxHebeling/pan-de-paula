"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { toBaseQty, type BaseUnit } from "@pdp/domain";
import { db, sql, withStaff, callFn } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import {
  bool,
  cents,
  failure,
  num,
  str,
  strOrNull,
  uuidOrNull,
  zCents,
  zId,
  zQty,
  zodMessage,
} from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";

const ingredientSchema = z.object({
  name: z.string().trim().min(2, "Nombre muy corto").max(80),
  brand: z.string().trim().max(60).nullable(),
  supplier_id: zId.nullable(),
  base_unit: z.enum(["g", "ml", "pz"], { error: "Unidad base inválida" }),
  min_stock_qty: z.number().min(0).max(1_000_000_000),
  is_available: z.boolean(),
  notes: z.string().trim().max(500).nullable(),
});

function parseIngredient(form: FormData) {
  return ingredientSchema.safeParse({
    name: str(form, "name") ?? "",
    brand: strOrNull(form, "brand"),
    supplier_id: uuidOrNull(form, "supplier_id"),
    base_unit: str(form, "base_unit"),
    min_stock_qty: num(form, "min_stock_qty") ?? 0,
    is_available: bool(form, "is_available"),
    notes: strOrNull(form, "notes"),
  });
}

const priceSchema = z.object({
  price_cents: zCents,
  qty: zQty,
  unit: z.string().trim().min(1, "Elige la unidad de compra"),
  package_label: z.string().trim().max(80).nullable(),
  supplier_id: zId.nullable(),
  add_stock: z.boolean(),
  packages: z.number().positive().max(100_000).default(1),
});

/** Convierte (cantidad, unidad de compra) a la unidad base del ingrediente; error legible si no es compatible. */
function toBase(
  qty: number,
  unit: string,
  base: BaseUnit,
): { ok: true; qty: number } | { ok: false; error: string } {
  try {
    return { ok: true, qty: toBaseQty(qty, unit, base).qty };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function revalidate(id?: string) {
  revalidatePath("/ingredientes");
  revalidatePath("/recetas");
  revalidatePath("/productos");
  if (id) revalidatePath(`/ingredientes/${id}`);
}

export async function createIngredient(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  const parsed = parseIngredient(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  // Precio inicial opcional (si se captura precio, se exige contenido y unidad)
  const priceRaw = cents(form, "price");
  let initialPrice: { price_cents: number; package_qty: number; label: string | null } | null =
    null;
  if (priceRaw !== undefined) {
    const pp = priceSchema.safeParse({
      price_cents: priceRaw,
      qty: num(form, "qty"),
      unit: str(form, "unit") ?? parsed.data.base_unit,
      package_label: strOrNull(form, "package_label"),
      supplier_id: parsed.data.supplier_id,
      add_stock: false,
      packages: 1,
    });
    if (!pp.success) return { error: zodMessage(pp.error) };
    const conv = toBase(pp.data.qty, pp.data.unit, parsed.data.base_unit);
    if (!conv.ok) return { error: conv.error };
    initialPrice = {
      price_cents: pp.data.price_cents,
      package_qty: conv.qty,
      label: pp.data.package_label,
    };
  }
  let id: string;
  try {
    id = await withStaff(db(), s.staff.id, async (trx) => {
      const r = await trx
        .insertInto("ingredients")
        .values(parsed.data)
        .returning("id")
        .executeTakeFirstOrThrow();
      if (initialPrice) {
        await callFn(trx, "record_ingredient_price", [
          r.id,
          initialPrice.package_qty,
          initialPrice.price_cents,
          initialPrice.label,
          parsed.data.supplier_id,
          false,
          1,
        ]);
      }
      return r.id;
    });
  } catch (e) {
    return failure("ingredientes.create", e);
  }
  revalidate();
  redirect(`/ingredientes/${id}?creado=1`);
}

export async function updateIngredient(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(id).success) return { error: "Ingrediente inválido" };
  const parsed = parseIngredient(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    const current = await db()
      .selectFrom("ingredients")
      .select("base_unit")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!current) return { error: "Ingrediente no encontrado" };
    if (current.base_unit !== parsed.data.base_unit) {
      const used = await db()
        .selectFrom("ingredient_prices")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("ingredient_id", "=", id)
        .executeTakeFirst();
      if ((used?.n ?? 0) > 0)
        return {
          error:
            "No se puede cambiar la unidad base: ya tiene precios o recetas registrados en la unidad actual.",
        };
    }
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .updateTable("ingredients")
        .set(parsed.data)
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .execute(),
    );
  } catch (e) {
    return failure("ingredientes.update", e);
  }
  revalidate(id);
  return { ok: "Ingrediente guardado." };
}

export async function recordIngredientPrice(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(id).success) return { error: "Ingrediente inválido" };
  const parsed = priceSchema.safeParse({
    price_cents: cents(form, "price"),
    qty: num(form, "qty"),
    unit: str(form, "unit") ?? "",
    package_label: strOrNull(form, "package_label"),
    supplier_id: uuidOrNull(form, "supplier_id"),
    add_stock: bool(form, "add_stock"),
    packages: num(form, "packages") ?? 1,
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const ing = await db()
    .selectFrom("ingredients")
    .select(["base_unit", "name"])
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!ing) return { error: "Ingrediente no encontrado" };
  const conv = toBase(parsed.data.qty, parsed.data.unit, ing.base_unit);
  if (!conv.ok) return { error: conv.error };
  let changed: Array<{ product_name: string; current_cost_cents: number; new_cost_cents: number }> =
    [];
  try {
    const unitCost = parsed.data.price_cents / 100 / conv.qty;
    const impact = await sql<{
      product_name: string;
      current_cost_cents: number;
      new_cost_cents: number;
    }>`
      select product_name, current_cost_cents, new_cost_cents from product_cost_impact(${id}, ${unitCost})`.execute(
      db(),
    );
    changed = impact.rows.filter((r) => r.current_cost_cents !== r.new_cost_cents);
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "record_ingredient_price", [
        id,
        conv.qty,
        parsed.data.price_cents,
        parsed.data.package_label,
        parsed.data.supplier_id,
        parsed.data.add_stock,
        parsed.data.packages,
      ]),
    );
  } catch (e) {
    return failure("ingredientes.price", e);
  }
  revalidate(id);
  const n = changed.length;
  return {
    ok:
      n === 0
        ? "Precio registrado. Ningún costo de producto cambió."
        : `Precio registrado. Cambió el costo de ${n} producto${n === 1 ? "" : "s"}.`,
  };
}

const movementSchema = z.object({
  type: z.enum(["PURCHASE", "CORRECTION", "WASTE"], { error: "Tipo de movimiento inválido" }),
  qty: z
    .number({ error: "Escribe una cantidad" })
    .refine((n) => n !== 0, "La cantidad no puede ser cero"),
  unit: z.string().trim().min(1),
  note: z.string().trim().max(300).nullable(),
});

export async function recordIngredientMovement(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(id).success) return { error: "Ingrediente inválido" };
  const parsed = movementSchema.safeParse({
    type: str(form, "type"),
    qty: num(form, "qty"),
    unit: str(form, "unit") ?? "",
    note: strOrNull(form, "note"),
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const ing = await db()
    .selectFrom("ingredients")
    .select("base_unit")
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!ing) return { error: "Ingrediente no encontrado" };
  const conv = toBase(Math.abs(parsed.data.qty), parsed.data.unit, ing.base_unit);
  if (!conv.ok) return { error: conv.error };
  // PURCHASE suma; WASTE resta; CORRECTION respeta el signo capturado.
  const signed =
    parsed.data.type === "PURCHASE"
      ? conv.qty
      : parsed.data.type === "WASTE"
        ? -conv.qty
        : Math.sign(parsed.data.qty) * conv.qty;
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("ingredient_movements")
        .values({
          ingredient_id: id,
          type: parsed.data.type,
          qty: signed,
          note: parsed.data.note,
          staff_id: s.staff.id,
          ref_type: "manual",
        })
        .execute(),
    );
  } catch (e) {
    return failure("ingredientes.movement", e);
  }
  revalidate(id);
  return { ok: "Movimiento registrado." };
}

export async function deleteIngredient(id: string): Promise<void> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(id).success) return;
  const used = await db()
    .selectFrom("recipe_items")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("ingredient_id", "=", id)
    .executeTakeFirst();
  if ((used?.n ?? 0) > 0) redirect(`/ingredientes/${id}?error=en-uso`);
  await withStaff(db(), s.staff.id, (trx) =>
    trx
      .updateTable("ingredients")
      .set({ deleted_at: new Date(), is_available: false })
      .where("id", "=", id)
      .execute(),
  );
  revalidate();
  redirect("/ingredientes?eliminado=1");
}

// ── Proveedores ──────────────────────────────────────────────────────────────
const supplierSchema = z.object({
  name: z.string().trim().min(2, "Nombre muy corto").max(80),
  contact: z.string().trim().max(80).nullable(),
  phone: z.string().trim().max(30).nullable(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Email inválido")
    .max(254)
    .nullable()
    .or(z.literal("").transform(() => null)),
  notes: z.string().trim().max(500).nullable(),
  is_active: z.boolean(),
});

function parseSupplier(form: FormData) {
  return supplierSchema.safeParse({
    name: str(form, "name") ?? "",
    contact: strOrNull(form, "contact"),
    phone: strOrNull(form, "phone"),
    email: str(form, "email") ?? "",
    notes: strOrNull(form, "notes"),
    is_active: bool(form, "is_active"),
  });
}

export async function createSupplier(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  const parsed = parseSupplier(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      trx.insertInto("suppliers").values(parsed.data).execute(),
    );
  } catch (e) {
    return failure("proveedores.create", e);
  }
  revalidatePath("/ingredientes/proveedores");
  revalidatePath("/ingredientes");
  return { ok: `Proveedor "${parsed.data.name}" creado.` };
}

export async function updateSupplier(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("recipes.write");
  if (!zId.safeParse(id).success) return { error: "Proveedor inválido" };
  const parsed = parseSupplier(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      trx.updateTable("suppliers").set(parsed.data).where("id", "=", id).execute(),
    );
  } catch (e) {
    return failure("proveedores.update", e);
  }
  revalidatePath("/ingredientes/proveedores");
  revalidatePath("/ingredientes");
  return { ok: "Proveedor guardado." };
}
