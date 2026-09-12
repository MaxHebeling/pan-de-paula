"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { slugify } from "@pdp/domain";
import { db, sql, withStaff, callFn } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import {
  bool,
  cents,
  failure,
  list,
  num,
  str,
  strOrNull,
  uuidOrNull,
  zCents,
  zId,
  zodMessage,
} from "@/lib/forms";
import { removeStoredImage, uploadFromForm } from "@/lib/uploads";
import type { ActionState } from "@/lib/action-state";

const slugRx = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const dateRx = /^\d{4}-\d{2}-\d{2}$/;

const productSchema = z
  .object({
    name: z.string().trim().min(2, "Nombre muy corto").max(120),
    slug: z.string().trim().regex(slugRx, "Slug inválido (minúsculas, números y guiones)").max(80),
    sku: z.string().trim().max(40).nullable(),
    short_description: z.string().trim().max(200).nullable(),
    description: z.string().trim().max(2000).nullable(),
    category_id: zId.nullable(),
    parent_id: zId.nullable(),
    variant_label: z.string().trim().max(40).nullable(),
    unit_label: z.string().trim().min(1).max(30),
    highlighted_ingredients: z.array(z.string().max(60)).max(20),
    allergens: z.array(z.string().max(40)).max(20),
    tags: z.array(z.string().max(40)).max(20),
    is_active: z.boolean(),
    is_featured: z.boolean(),
    show_on_web: z.boolean(),
    show_on_pos: z.boolean(),
    track_stock: z.boolean(),
    allow_preorder: z.boolean(),
    requires_preorder: z.boolean(),
    pos_favorite: z.boolean(),
    preparation_hours: z.number().int().min(0).max(720).nullable(),
    season_start: z.string().regex(dateRx, "Fecha inválida").nullable(),
    season_end: z.string().regex(dateRx, "Fecha inválida").nullable(),
    sort_order: z.number().int().min(0).max(9999),
  })
  .refine((v) => !v.parent_id || (v.variant_label && v.variant_label.length > 0), {
    message: "Una variante necesita etiqueta (ej. Chico, Nutella)",
    path: ["variant_label"],
  })
  .refine((v) => !(v.season_start && v.season_end) || v.season_start <= v.season_end, {
    message: "La temporada termina antes de empezar",
    path: ["season_end"],
  });

function parseProduct(form: FormData) {
  const name = str(form, "name") ?? "";
  return productSchema.safeParse({
    name,
    slug: str(form, "slug") ?? slugify(name),
    sku: strOrNull(form, "sku"),
    short_description: strOrNull(form, "short_description"),
    description: strOrNull(form, "description"),
    category_id: uuidOrNull(form, "category_id"),
    parent_id: uuidOrNull(form, "parent_id"),
    variant_label: strOrNull(form, "variant_label"),
    unit_label: str(form, "unit_label") ?? "pieza",
    highlighted_ingredients: list(form, "highlighted_ingredients"),
    allergens: list(form, "allergens"),
    tags: list(form, "tags"),
    is_active: bool(form, "is_active"),
    is_featured: bool(form, "is_featured"),
    show_on_web: bool(form, "show_on_web"),
    show_on_pos: bool(form, "show_on_pos"),
    track_stock: bool(form, "track_stock"),
    allow_preorder: bool(form, "allow_preorder"),
    requires_preorder: bool(form, "requires_preorder"),
    pos_favorite: bool(form, "pos_favorite"),
    preparation_hours: num(form, "preparation_hours") ?? null,
    season_start: strOrNull(form, "season_start"),
    season_end: strOrNull(form, "season_end"),
    sort_order: num(form, "sort_order") ?? 0,
  });
}

function revalidate(id?: string) {
  revalidatePath("/productos");
  revalidatePath("/precios");
  revalidatePath("/recetas");
  if (id) revalidatePath(`/productos/${id}`);
}

export async function createProduct(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  const parsed = parseProduct(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const price = zCents.safeParse(cents(form, "price"));
  if (!price.success) return { error: "Escribe el precio regular (ej. 45.00)" };
  let id: string;
  try {
    id = await withStaff(db(), s.staff.id, async (trx) => {
      const p = await trx
        .insertInto("products")
        .values(parsed.data)
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("product_prices")
        .values({
          product_id: p.id,
          channel: "all",
          kind: "regular",
          price_cents: price.data,
          created_by: s.staff.id,
        })
        .execute();
      return p.id;
    });
  } catch (e) {
    return failure("productos.create", e);
  }
  revalidate();
  redirect(`/productos/${id}?creado=1`);
}

export async function updateProduct(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return { error: "Producto inválido" };
  const parsed = parseProduct(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  if (parsed.data.parent_id === id)
    return { error: "Un producto no puede ser variante de sí mismo" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .updateTable("products")
        .set(parsed.data)
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .execute(),
    );
  } catch (e) {
    return failure("productos.update", e);
  }
  revalidate(id);
  return { ok: "Producto guardado." };
}

const variantSchema = z.object({
  variant_label: z.string().trim().min(1, "Escribe la etiqueta de la variante").max(40),
  name: z.string().trim().min(2).max(120),
  price: zCents,
});

export async function createVariant(
  parentId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(parentId).success) return { error: "Producto inválido" };
  const parent = await db()
    .selectFrom("products")
    .select([
      "id",
      "name",
      "slug",
      "category_id",
      "unit_label",
      "track_stock",
      "show_on_web",
      "show_on_pos",
      "allow_preorder",
      "requires_preorder",
      "preparation_hours",
    ])
    .where("id", "=", parentId)
    .where("deleted_at", "is", null)
    .where("parent_id", "is", null)
    .executeTakeFirst();
  if (!parent) return { error: "Solo los productos principales pueden tener variantes" };
  const label = str(form, "variant_label") ?? "";
  const parsed = variantSchema.safeParse({
    variant_label: label,
    name: str(form, "name") ?? `${parent.name} ${label}`.trim(),
    price: cents(form, "price"),
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      const base = slugify(`${parent.slug}-${parsed.data.variant_label}`);
      const taken = await trx
        .selectFrom("products")
        .select("id")
        .where("slug", "=", base)
        .executeTakeFirst();
      const slug = taken ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base;
      const v = await trx
        .insertInto("products")
        .values({
          name: parsed.data.name,
          slug,
          parent_id: parent.id,
          variant_label: parsed.data.variant_label,
          category_id: parent.category_id,
          unit_label: parent.unit_label,
          track_stock: parent.track_stock,
          show_on_web: parent.show_on_web,
          show_on_pos: parent.show_on_pos,
          allow_preorder: parent.allow_preorder,
          requires_preorder: parent.requires_preorder,
          preparation_hours: parent.preparation_hours,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("product_prices")
        .values({
          product_id: v.id,
          channel: "all",
          kind: "regular",
          price_cents: parsed.data.price,
          created_by: s.staff.id,
        })
        .execute();
    });
  } catch (e) {
    return failure("productos.variant", e);
  }
  revalidate(parentId);
  return { ok: `Variante "${parsed.data.variant_label}" creada.` };
}

export async function uploadProductImage(
  productId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success) return { error: "Producto inválido" };
  const alt = strOrNull(form, "alt");
  try {
    const url = await uploadFromForm(form, "image", "products");
    if (!url) return { error: "Selecciona una imagen (JPG, PNG, WebP o AVIF, máx. 5 MB)" };
    await withStaff(db(), s.staff.id, async (trx) => {
      const agg = await trx
        .selectFrom("product_images")
        .select([
          sql<number>`count(*)::int`.as("n"),
          sql<number>`coalesce(max(sort_order), 0)`.as("max"),
        ])
        .where("product_id", "=", productId)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("product_images")
        .values({
          product_id: productId,
          url,
          alt,
          sort_order: agg.max + 1,
          is_primary: agg.n === 0,
        })
        .execute();
    });
  } catch (e) {
    return failure("productos.image", e);
  }
  revalidate(productId);
  return { ok: "Imagen subida." };
}

export async function setPrimaryImage(productId: string, imageId: string): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success || !zId.safeParse(imageId).success) return;
  await withStaff(db(), s.staff.id, async (trx) => {
    await trx
      .updateTable("product_images")
      .set({ is_primary: false })
      .where("product_id", "=", productId)
      .execute();
    await trx
      .updateTable("product_images")
      .set({ is_primary: true })
      .where("id", "=", imageId)
      .where("product_id", "=", productId)
      .execute();
  });
  revalidate(productId);
}

export async function moveImage(
  productId: string,
  imageId: string,
  dir: "up" | "down",
): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success || !zId.safeParse(imageId).success) return;
  await withStaff(db(), s.staff.id, async (trx) => {
    const rows = await trx
      .selectFrom("product_images")
      .select("id")
      .where("product_id", "=", productId)
      .orderBy("sort_order")
      .orderBy("created_at")
      .execute();
    const order = rows.map((r) => r.id);
    const i = order.indexOf(imageId);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (let k = 0; k < order.length; k++)
      await trx
        .updateTable("product_images")
        .set({ sort_order: k + 1 })
        .where("id", "=", order[k]!)
        .execute();
  });
  revalidate(productId);
}

export async function deleteProductImage(productId: string, imageId: string): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(productId).success || !zId.safeParse(imageId).success) return;
  const removed = await withStaff(db(), s.staff.id, async (trx) => {
    const img = await trx
      .deleteFrom("product_images")
      .where("id", "=", imageId)
      .where("product_id", "=", productId)
      .returning(["url", "is_primary"])
      .executeTakeFirst();
    if (img?.is_primary) {
      const next = await trx
        .selectFrom("product_images")
        .select("id")
        .where("product_id", "=", productId)
        .orderBy("sort_order")
        .executeTakeFirst();
      if (next)
        await trx
          .updateTable("product_images")
          .set({ is_primary: true })
          .where("id", "=", next.id)
          .execute();
    }
    return img?.url ?? null;
  });
  await removeStoredImage(removed);
  revalidate(productId);
}

export async function setProductActive(id: string, active: boolean): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return;
  await withStaff(db(), s.staff.id, (trx) =>
    trx.updateTable("products").set({ is_active: active }).where("id", "=", id).execute(),
  );
  revalidate(id);
}

/** Soft delete. Si el producto (o sus variantes) tiene ventas, no se elimina: se desactiva. */
export async function deleteProduct(id: string): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return;
  const hasSales = await callFn<boolean>(db(), "product_has_sales", [id]);
  if (hasSales) {
    await setProductActive(id, false);
    redirect(`/productos/${id}?aviso=ventas`);
  }
  await withStaff(db(), s.staff.id, (trx) =>
    trx
      .updateTable("products")
      .set({ deleted_at: new Date(), is_active: false })
      .where((eb) => eb.or([eb("id", "=", id), eb("parent_id", "=", id)]))
      .execute(),
  );
  revalidate();
  redirect("/productos?eliminado=1");
}
