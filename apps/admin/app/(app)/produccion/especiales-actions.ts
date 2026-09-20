"use server";
/**
 * Productos especiales o temporales (navideños, de temporada, ediciones limitadas).
 *
 * NO hay modelo, inventario ni tabla de precios aparte: un especial es una fila de `products` con
 * `is_temporary = true` (migración 0017). Todo lo que ocurre aquí pasa por lo que ya existe:
 *   · precio  → `set_regular_price` (mismo SQL que /precios: cierra la vigencia anterior, deja historial),
 *   · stock   → `record_stock_correction` (mismo SQL que las correcciones de /inventario, append-only),
 *   · activo  → `setProductFlag` de /productos (auditado por el trigger de la tabla),
 *   · precio en línea → `setProductPrice` de /productos.
 * Las dos últimas las usa la pantalla tal cual (se importan de /productos): aquí no se reimplementan.
 *
 * Permisos: nombre y precio con `catalog.write`; stock con `inventory.write` (el mismo de las
 * correcciones de inventario). Siempre validado en el servidor.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { findSimilar, normalizeName, slugify } from "@pdp/domain";
import { db, sql, withStaff, callFn } from "@/lib/db";
import { requireSession, hasPermission } from "@/lib/auth";
import { cents, failure, num, str, zCents, zId, zodMessage } from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";

/**
 * Dos nombres distintos que se parecen tanto probablemente son el mismo producto. Un poco más
 * estricto que la importación del Sheets (0.7) porque aquí frena un alta: "Rosca de Reyes grande"
 * avisa (0.81) y "Rosca de Reyes chica" vs "grande" no (0.70), que sí son productos distintos.
 */
const SIMILAR_THRESHOLD = 0.8;

/**
 * Lo que el alta rápida fija por su cuenta. El resto de `products` (descripción, imagen, categoría,
 * temporada, SKU, variantes…) ya existe en el modelo y se edita en /productos/[id]; el día que el
 * dueño los quiera también aquí, se agregan al formulario y a este objeto — nada más cambia.
 * `allow_preorder: false` porque una edición limitada agotada está agotada: así el sitio aplica la
 * regla de "Agotado" que ya vive en apps/web/lib/availability.ts, sin inventar nada nuevo.
 */
const SPECIAL_DEFAULTS = {
  is_temporary: true,
  is_active: true,
  show_on_web: true,
  show_on_pos: true,
  track_stock: true,
  allow_preorder: false,
  requires_preorder: false,
  unit_label: "pieza",
} as const;

const specialSchema = z.object({
  name: z.string().trim().min(2, "Escribe el nombre del producto").max(120),
  price_cents: zCents,
  initial_stock: z
    .number({ error: "Escribe un stock válido" })
    .int("El stock inicial debe ser un número entero")
    .min(0, "El stock inicial no puede ser negativo")
    .max(100_000, "Stock inicial demasiado grande"),
});

type ProductRow = { id: string; name: string; is_active: boolean; is_temporary: boolean };

export type DuplicateInfo = {
  duplicate_id: string;
  duplicate_name: string;
  duplicate_active: boolean;
  duplicate_temporary: boolean;
  /** "exact" = mismo nombre normalizado; "similar" = se parece por encima del umbral. */
  duplicate_kind: "exact" | "similar";
};

function revalidate(productId?: string) {
  revalidatePath("/produccion");
  revalidatePath("/productos");
  revalidatePath("/precios");
  revalidatePath("/inventario");
  if (productId) {
    revalidatePath(`/productos/${productId}`);
    revalidatePath(`/precios/${productId}`);
  }
}

/**
 * ¿Ya existe este producto? Compara por nombre normalizado (`@pdp/domain`: minúsculas, sin acentos
 * ni signos) y, si no hay coincidencia exacta, por parecido con trigramas. Incluye productos
 * inactivos a propósito: la respuesta correcta a "ya existe pero apagado" es reactivarlo.
 */
async function findEquivalent(name: string, excludeId?: string): Promise<DuplicateInfo | null> {
  const rows = await db()
    .selectFrom("products")
    .select(["id", "name", "is_active", "is_temporary"])
    .where("deleted_at", "is", null)
    .execute();
  const others: ProductRow[] = rows.filter((r) => r.id !== excludeId);
  const wanted = normalizeName(name);
  const exact = others.find((r) => normalizeName(r.name) === wanted);
  const found = exact
    ? { item: exact, kind: "exact" as const }
    : (() => {
        const s = findSimilar(name, others, (r) => r.name, SIMILAR_THRESHOLD);
        return s ? { item: s.item, kind: "similar" as const } : null;
      })();
  if (!found) return null;
  return {
    duplicate_id: found.item.id,
    duplicate_name: found.item.name,
    duplicate_active: found.item.is_active,
    duplicate_temporary: found.item.is_temporary,
    duplicate_kind: found.kind,
  };
}

function duplicateMessage(d: DuplicateInfo): string {
  const donde = d.duplicate_temporary ? "" : " (producto permanente del catálogo)";
  if (!d.duplicate_active)
    return d.duplicate_kind === "exact"
      ? `Ya existe "${d.duplicate_name}"${donde}, desactivado. Reactívalo en lugar de crear otro igual.`
      : `Se parece mucho a "${d.duplicate_name}"${donde}, que está desactivado. Reactívalo o confirma que es otro producto.`;
  return d.duplicate_kind === "exact"
    ? `Ya existe "${d.duplicate_name}"${donde} y está activo. Edítalo en lugar de duplicarlo.`
    : `Se parece mucho a "${d.duplicate_name}"${donde}, que ya está activo. Confirma que es otro producto.`;
}

/** Slug único a partir del nombre (misma estrategia que las variantes del catálogo). */
async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name) || `especial-${Date.now().toString(36)}`;
  const taken = await db()
    .selectFrom("products")
    .select("id")
    .where("slug", "=", base)
    .executeTakeFirst();
  return taken ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base;
}

/**
 * Alta de un producto especial: producto + precio regular + stock inicial, en una transacción.
 * Antes de crear busca un equivalente por nombre; si lo encuentra devuelve el error con los datos
 * del candidato para que la pantalla ofrezca reactivarlo.
 */
export async function createSpecialProduct(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  // React limpia el formulario al terminar la acción: lo capturado se devuelve en `data` y la
  // pantalla lo vuelve a poner como valor por defecto, para que un error no borre lo que escribieron
  // (y para que "crear de todos modos" reenvíe lo mismo).
  const typed = {
    form_name: str(form, "name") ?? "",
    form_price: str(form, "price") ?? "",
    form_stock: str(form, "initial_stock") ?? "",
  };
  const parsed = specialSchema.safeParse({
    name: str(form, "name") ?? "",
    price_cents: cents(form, "price"),
    initial_stock: num(form, "initial_stock") ?? 0,
  });
  if (!parsed.success) return { error: zodMessage(parsed.error), data: { ...typed } };
  const { name, price_cents, initial_stock } = parsed.data;
  // El stock inicial es una corrección de inventario: exige el mismo permiso que /inventario.
  if (initial_stock > 0 && !hasPermission(s, "inventory.write"))
    return {
      error:
        "No tienes permiso para ajustar inventario (inventory.write). Crea el producto con stock 0 y pide el ajuste a producción.",
      data: { ...typed },
    };

  const confirmSimilar = str(form, "confirm_similar") === "1";
  const dup = await findEquivalent(name);
  // Un nombre idéntico nunca se duplica. Un simple parecido sí, pero solo si lo confirman.
  if (dup && (dup.duplicate_kind === "exact" || !confirmSimilar))
    return { error: duplicateMessage(dup), data: { ...dup, ...typed } };

  let id: string;
  try {
    const slug = await uniqueSlug(name);
    id = await withStaff(db(), s.staff.id, async (trx) => {
      const p = await trx
        .insertInto("products")
        .values({ ...SPECIAL_DEFAULTS, name, slug })
        .returning("id")
        .executeTakeFirstOrThrow();
      // Precio: misma función que /precios (historial en product_prices; nada escrito a mano).
      await callFn(trx, "set_regular_price", [
        p.id,
        "all",
        price_cents,
        "Alta de producto especial",
      ]);
      // Stock inicial: movimiento INITIAL, no un lote de producción falso.
      if (initial_stock > 0)
        await callFn(trx, "record_stock_correction", [
          p.id,
          initial_stock,
          "initial",
          "alta de producto especial",
        ]);
      return p.id;
    });
  } catch (e) {
    return { ...failure("especiales.create", e), data: { ...typed } };
  }
  revalidate(id);
  return {
    ok: `"${name}" creado y activo${initial_stock > 0 ? ` con ${initial_stock} en stock` : " (sin stock todavía)"}.`,
    data: { product_id: id },
  };
}

/** Reactiva un producto existente (la alternativa a duplicarlo). No toca precio ni stock. */
export async function reactivateProduct(id: string): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return { error: "Producto inválido" };
  let row: { name: string; is_temporary: boolean } | undefined;
  try {
    row = await withStaff(db(), s.staff.id, async (trx) => {
      const r = await trx
        .updateTable("products")
        .set({ is_active: true })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returning(["name", "is_temporary"])
        .executeTakeFirst();
      return r;
    });
  } catch (e) {
    return failure("especiales.reactivate", e);
  }
  if (!row) return { error: "El producto ya no existe." };
  revalidate(id);
  return {
    ok: row.is_temporary
      ? `"${row.name}" se reactivó. Revisa su precio y su stock antes de venderlo.`
      : `"${row.name}" se reactivó en el catálogo permanente (no aparece en esta lista).`,
    data: { product_id: id, is_temporary: row.is_temporary },
  };
}

const nameSchema = z.string().trim().min(2, "Nombre muy corto").max(120);

/** Cambia el nombre desde la lista. El slug (la URL pública) no se toca: se edita en /productos/[id]. */
export async function setSpecialName(id: string, value: unknown): Promise<ActionState> {
  const s = await requireSession("catalog.write");
  if (!zId.safeParse(id).success) return { error: "Producto inválido" };
  const parsed = nameSchema.safeParse(typeof value === "string" ? value : "");
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const dup = await findEquivalent(parsed.data, id);
  if (dup?.duplicate_kind === "exact")
    return { error: `Ya existe "${dup.duplicate_name}" con ese nombre.` };
  try {
    const r = await withStaff(db(), s.staff.id, (trx) =>
      trx
        .updateTable("products")
        .set({ name: parsed.data })
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .returning("id")
        .executeTakeFirst(),
    );
    if (!r) return { error: "El producto ya no existe." };
  } catch (e) {
    return failure("especiales.name", e);
  }
  revalidate(id);
  return { ok: "Nombre guardado." };
}

const stockSchema = z
  .number({ error: "Escribe una cantidad válida" })
  .int("El stock debe ser un número entero")
  .min(0, "El stock no puede ser negativo")
  .max(1_000_000, "Cantidad demasiado grande");

/**
 * Deja el stock en la cantidad indicada con UNA corrección de inventario (la diferencia), igual que
 * el ajuste rápido de /inventario. Nunca escribe `inventory_levels`: el nivel lo recalcula el trigger.
 */
export async function setSpecialStock(id: string, value: unknown): Promise<ActionState> {
  const s = await requireSession("inventory.write");
  if (!zId.safeParse(id).success) return { error: "Producto inválido" };
  const parsed = stockSchema.safeParse(typeof value === "number" ? value : Number(value));
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const target = parsed.data;
  try {
    const r = await sql<{ track_stock: boolean; on_hand: string }>`
      select p.track_stock, coalesce(l.on_hand, 0)::text as on_hand
      from products p left join inventory_levels l on l.product_id = p.id
      where p.id = ${id} and p.deleted_at is null`.execute(db());
    const row = r.rows[0];
    if (!row) return { error: "El producto ya no existe." };
    if (!row.track_stock) return { error: "Este producto no lleva control de stock." };
    const delta = target - Number(row.on_hand);
    if (delta === 0) return { ok: "El stock ya estaba en esa cantidad." };
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "record_stock_correction", [
        id,
        delta,
        "difference",
        "ajuste desde productos especiales",
      ]),
    );
  } catch (e) {
    return failure("especiales.stock", e);
  }
  revalidate(id);
  return { ok: `Stock ajustado a ${target}.` };
}
