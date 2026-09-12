/** Productos: alta con categoría por nombre, slug y precio regular 'all'. Existentes: completa lo que falte. */
import { slugify } from "@pdp/domain";
import { sql } from "kysely";
import { normalizeName } from "../normalize.ts";
import type { EntityHandler, WorkUnit } from "../types.ts";
import {
  bool,
  errorUnit,
  loadCategories,
  loadProducts,
  mappedErrors,
  num,
  resolveByName,
  rowFrom,
  similarReason,
  skippedUnit,
  str,
} from "./common.ts";

export const products: EntityHandler = {
  entity: "products",
  fields: {
    name: { transform: "text", required: true, help: "Nombre del producto (Producto)" },
    category: { transform: "text", help: "Categoría por nombre (se crea si no existe)" },
    sku: { transform: "text", help: "SKU / código interno" },
    slug: { transform: "text", help: "Slug para la web (default: generado del nombre)" },
    price_cents: { transform: "money", help: "Precio de venta regular (Precio)" },
    short_description: { transform: "text", help: "Descripción corta" },
    description: { transform: "text", help: "Descripción larga" },
    unit_label: { transform: "text", help: "pieza, paquete, caja…" },
    is_active: { transform: "bool", help: "Activo/vendible" },
    show_on_web: { transform: "bool", help: "Visible en la tienda" },
    show_on_pos: { transform: "bool", help: "Visible en POS" },
    track_stock: { transform: "bool", help: "Controla inventario" },
    requires_preorder: { transform: "bool", help: "Solo bajo pedido" },
    is_featured: { transform: "bool", help: "Destacado" },
    sort_order: { transform: "int", help: "Orden" },
  },
  async plan(rows, ctx) {
    const existing = await loadProducts(ctx.db);
    const categories = await loadCategories(ctx.db);
    const priced = new Set(
      (
        await sql<{ product_id: string }>`select distinct product_id from product_prices`.execute(
          ctx.db,
        )
      ).rows.map((r) => r.product_id),
    );
    const usedSlugs = new Set(existing.map((p) => p.slug));
    const seen = new Map<string, number>();
    const units: WorkUnit[] = [];
    for (const mr of rows) {
      const bad = mappedErrors(mr);
      if (bad) {
        units.push(bad);
        continue;
      }
      const name = str(mr.values.name)!;
      const key = normalizeName(name);
      if (seen.has(key)) {
        units.push(
          skippedUnit(
            mr,
            `Duplicado en el archivo (misma fila que la ${seen.get(key)})`,
            mr.values,
          ),
        );
        continue;
      }
      seen.set(key, mr.rowNumber);
      const price = num(mr.values.price_cents);
      if (price !== null && price < 0) {
        units.push(errorUnit(mr, "Precio negativo", mr.values));
        continue;
      }
      const wantedSlug = str(mr.values.slug) ?? slugify(name);
      const res = resolveByName(
        name,
        existing,
        (p) => p.name,
        ctx,
        (p) => p.slug === wantedSlug,
      );
      const categoryName = str(mr.values.category);
      const normalized = {
        name,
        slug: wantedSlug,
        sku: str(mr.values.sku),
        category: categoryName,
        price_cents: price,
        short_description: str(mr.values.short_description),
        description: str(mr.values.description),
        unit_label: str(mr.values.unit_label),
        is_active: bool(mr.values.is_active),
        show_on_web: bool(mr.values.show_on_web),
        show_on_pos: bool(mr.values.show_on_pos),
        track_stock: bool(mr.values.track_stock),
        requires_preorder: bool(mr.values.requires_preorder),
        is_featured: bool(mr.values.is_featured),
        sort_order: num(mr.values.sort_order),
      };
      if (res.kind === "similar" && ctx.options.similar_policy === "skip") {
        units.push(skippedUnit(mr, similarReason(name, res.item.name, res.score), normalized));
        continue;
      }
      const resolveCategory = async (
        trx: Parameters<NonNullable<WorkUnit["apply"]>>[0],
      ): Promise<string | null> => {
        if (!categoryName) return null;
        const n = normalizeName(categoryName);
        const hit = categories.find((c) => normalizeName(c.name) === n);
        if (hit) return hit.id;
        let slug = slugify(categoryName);
        if (categories.some((c) => c.slug === slug)) slug = `${slug}-${categories.length + 1}`;
        const ins = await sql<{
          id: string;
        }>`insert into categories(slug, name, sort_order) values (${slug}, ${categoryName}, ${categories.length + 1}) returning id`.execute(
          trx,
        );
        categories.push({ id: ins.rows[0]!.id, name: categoryName, slug });
        return ins.rows[0]!.id;
      };
      if (res.kind === "exact") {
        const p = res.item;
        const needsCategory = p.category_id === null && categoryName !== null;
        const needsPrice = !priced.has(p.id) && price !== null;
        const willUpdate = needsCategory || needsPrice;
        const row = rowFrom(mr, willUpdate ? "updated" : "matched", normalized);
        row.targetId = p.id;
        if (!willUpdate)
          row.warnings.push(
            "Ya existe; no se modifican nombre, categoría ni precio (usa la entidad prices para cambiar precios)",
          );
        units.push({
          key: `row-${mr.rowNumber}`,
          rows: [row],
          apply: async (trx) => {
            if (needsCategory) {
              const cid = await resolveCategory(trx);
              await sql`update products set category_id = ${cid} where id = ${p.id}`.execute(trx);
            }
            if (needsPrice) {
              await sql`insert into product_prices(product_id, channel, kind, price_cents, created_by) values (${p.id}, 'all', 'regular', ${price}, current_staff_id())`.execute(
                trx,
              );
              priced.add(p.id);
            }
            return { targetId: p.id, action: willUpdate ? "updated" : "matched" };
          },
        });
        continue;
      }
      let slug = wantedSlug;
      let i = 2;
      while (usedSlugs.has(slug)) slug = `${wantedSlug}-${i++}`;
      usedSlugs.add(slug);
      normalized.slug = slug;
      const row = rowFrom(mr, "created", normalized);
      if (price === null)
        row.warnings.push("Sin precio: el producto no se podrá vender hasta asignarle uno");
      units.push({
        key: `row-${mr.rowNumber}`,
        rows: [row],
        apply: async (trx) => {
          const cid = await resolveCategory(trx);
          const ins = await sql<{
            id: string;
          }>`insert into products(name, slug, sku, category_id, short_description, description, unit_label,
                        is_active, show_on_web, show_on_pos, track_stock, requires_preorder, is_featured, sort_order)
                 values (${name}, ${slug}, ${normalized.sku}, ${cid}, ${normalized.short_description}, ${normalized.description},
                         coalesce(${normalized.unit_label}, 'pieza'), coalesce(${normalized.is_active}, true), coalesce(${normalized.show_on_web}, true),
                         coalesce(${normalized.show_on_pos}, true), coalesce(${normalized.track_stock}, true), coalesce(${normalized.requires_preorder}, false),
                         coalesce(${normalized.is_featured}, false), coalesce(${normalized.sort_order}, 0)) returning id`.execute(
            trx,
          );
          const id = ins.rows[0]!.id;
          if (price !== null)
            await sql`insert into product_prices(product_id, channel, kind, price_cents, created_by) values (${id}, 'all', 'regular', ${price}, current_staff_id())`.execute(
              trx,
            );
          existing.push({
            id,
            name,
            slug,
            category_id: cid,
            is_active: normalized.is_active ?? true,
          });
          return { targetId: id, action: "created" };
        },
      });
    }
    return units;
  },
};
