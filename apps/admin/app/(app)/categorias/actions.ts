"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db, sql, withStaff } from "@/lib/db";
import { slugify } from "@pdp/domain";

import { requireSession } from "@/lib/auth";
import { bool, failure, num, str, strOrNull, zId, zodMessage } from "@/lib/forms";
import { removeStoredImage, uploadFromForm } from "@/lib/uploads";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({
  name: z.string().trim().min(2, "Nombre muy corto").max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug inválido (minúsculas, números y guiones)")
    .max(80),
  description: z.string().trim().max(500).nullable(),
  sort_order: z.number().int().min(0).max(9999),
  is_active: z.boolean(),
});

function parse(form: FormData) {
  const name = str(form, "name") ?? "";
  return schema.safeParse({
    name,
    slug: str(form, "slug") ?? slugify(name),
    description: strOrNull(form, "description"),
    sort_order: num(form, "sort_order") ?? 0,
    is_active: bool(form, "is_active"),
  });
}

function revalidate() {
  revalidatePath("/categorias");
  revalidatePath("/productos");
}

export async function createCategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  const parsed = parse(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    const image_url = await uploadFromForm(form, "image", "categories");
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("categories")
        .values({ ...parsed.data, image_url })
        .execute(),
    );
  } catch (e) {
    return failure("categorias.create", e);
  }
  revalidate();
  return { ok: `Categoría "${parsed.data.name}" creada.` };
}

export async function updateCategory(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return { error: "Categoría inválida" };
  const parsed = parse(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    const current = await db()
      .selectFrom("categories")
      .select("image_url")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!current) return { error: "Categoría no encontrada" };
    const newImage = await uploadFromForm(form, "image", "categories");
    const removeImage = bool(form, "remove_image");
    const image_url = newImage ?? (removeImage ? null : current.image_url);
    await withStaff(db(), s.staff.id, (trx) =>
      trx.updateTable("categories").set({ ...parsed.data, image_url }).where("id", "=", id).execute(),
    );
    if ((newImage || removeImage) && current.image_url) await removeStoredImage(current.image_url);
  } catch (e) {
    return failure("categorias.update", e);
  }
  revalidate();
  return { ok: "Categoría guardada." };
}

export async function toggleCategory(id: string, active: boolean): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return;
  await withStaff(db(), s.staff.id, (trx) =>
    trx.updateTable("categories").set({ is_active: active }).where("id", "=", id).execute(),
  );
  revalidate();
}

/** Mueve la categoría una posición arriba/abajo intercambiando sort_order con la vecina. */
export async function moveCategory(id: string, dir: "up" | "down"): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return;
  await withStaff(db(), s.staff.id, async (trx) => {
    const rows = await trx
      .selectFrom("categories")
      .select(["id", "sort_order"])
      .where("deleted_at", "is", null)
      .orderBy("sort_order")
      .orderBy("name")
      .execute();
    const i = rows.findIndex((r) => r.id === id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return;
    // Normaliza a posiciones consecutivas y luego intercambia (evita empates en sort_order).
    const order = rows.map((r) => r.id);
    [order[i], order[j]] = [order[j]!, order[i]!];
    for (let k = 0; k < order.length; k++) {
      await trx.updateTable("categories").set({ sort_order: k + 1 }).where("id", "=", order[k]!).execute();
    }
  });
  revalidate();
}

export async function deleteCategory(id: string): Promise<void> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return;
  const inUse = await db()
    .selectFrom("products")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("category_id", "=", id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if ((inUse?.n ?? 0) > 0) redirect(`/categorias/${id}?error=en-uso`);
  await withStaff(db(), s.staff.id, (trx) =>
    trx
      .updateTable("categories")
      .set({ deleted_at: new Date(), is_active: false })
      .where("id", "=", id)
      .execute(),
  );
  revalidate();
  redirect("/categorias");
}
