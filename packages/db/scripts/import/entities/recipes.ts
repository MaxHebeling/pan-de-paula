/** Recetas (formato largo: una fila por producto+ingrediente). La receta completa se aplica o falla junta. */
import { toBaseQty } from "@pdp/domain";
import { sql } from "kysely";
import { normalizeName } from "../normalize.ts";
import type { EntityHandler, MappedRow, RowResult, WorkUnit } from "../types.ts";
import { loadIngredients, loadProducts, mappedErrors, num, rowFrom, str } from "./common.ts";

type ExistingRecipe = {
  id: string;
  product_id: string;
  yield_qty: string;
  labor_cents: number;
  overhead_cents: number;
  version: number;
};
type ExistingLine = { recipe_id: string; ingredient_id: string; qty: string };

export const recipes: EntityHandler = {
  entity: "recipes",
  fields: {
    product: {
      transform: "text",
      required: true,
      help: "Producto al que pertenece la receta (Producto)",
    },
    ingredient: { transform: "text", required: true, help: "Ingrediente (Ingrediente)" },
    qty: { transform: "qty", required: true, help: "Cantidad del ingrediente (Cantidad)" },
    unit: {
      transform: "unit",
      help: "Unidad de la cantidad (default: unidad base del ingrediente)",
    },
    yield_qty: { transform: "qty", help: "Piezas que rinde la receta (Rendimiento)" },
    yield_label: { transform: "text", help: "Etiqueta del rendimiento, ej. '12 piezas'" },
    labor_cents: { transform: "money", help: "Mano de obra por lote" },
    overhead_cents: { transform: "money", help: "Gastos indirectos por lote" },
    notes: { transform: "text", help: "Notas" },
  },
  async plan(rows, ctx) {
    const products = await loadProducts(ctx.db);
    const ingredients = await loadIngredients(ctx.db);
    const existing = new Map<string, ExistingRecipe>();
    for (const r of (
      await sql<ExistingRecipe>`select id, product_id, yield_qty::text as yield_qty, labor_cents, overhead_cents, version from recipes`.execute(
        ctx.db,
      )
    ).rows)
      existing.set(r.product_id, r);
    const lines = new Map<string, Map<string, number>>();
    for (const l of (
      await sql<ExistingLine>`select recipe_id, ingredient_id, qty::text as qty from recipe_items`.execute(
        ctx.db,
      )
    ).rows) {
      if (!lines.has(l.recipe_id)) lines.set(l.recipe_id, new Map());
      lines.get(l.recipe_id)!.set(l.ingredient_id, Number(l.qty));
    }
    // Agrupar por producto conservando el orden de aparición
    const groups = new Map<string, MappedRow[]>();
    const units: WorkUnit[] = [];
    for (const mr of rows) {
      const bad = mappedErrors(mr);
      if (bad) {
        units.push(bad);
        continue;
      }
      const k = normalizeName(str(mr.values.product)!);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(mr);
    }
    for (const [, grp] of groups) {
      const productName = str(grp[0]!.values.product)!;
      const product = products.find(
        (p) =>
          normalizeName(p.name) === normalizeName(productName) ||
          p.slug === normalizeName(productName).replace(/ /g, "-"),
      );
      const results: RowResult[] = [];
      const planned: Array<{ ingredientId: string; qtyBase: number; sort: number }> = [];
      let failed = false;
      if (!product) {
        for (const mr of grp) {
          const r = rowFrom(mr, "error", mr.values);
          r.error = `Producto «${productName}» no existe. Importa productos antes que recetas.`;
          results.push(r);
        }
        units.push({ key: `recipe-${productName}`, rows: results });
        continue;
      }
      const seenIng = new Set<string>();
      let sort = 0;
      for (const mr of grp) {
        const ingName = str(mr.values.ingredient)!;
        const ing = ingredients.find((i) => normalizeName(i.name) === normalizeName(ingName));
        const r = rowFrom(mr, "created", mr.values);
        if (!ing) {
          r.action = "error";
          r.error = `Ingrediente «${ingName}» no existe. Importa ingredientes antes que recetas.`;
          failed = true;
        } else if (seenIng.has(ing.id)) {
          r.action = "error";
          r.error = `Ingrediente «${ingName}» repetido en la receta de «${productName}»`;
          failed = true;
        } else {
          seenIng.add(ing.id);
          const qty = num(mr.values.qty)!;
          const unit = str(mr.values.unit) ?? ctx.options.default_unit ?? ing.base_unit;
          try {
            if (qty <= 0) throw new Error("La cantidad debe ser mayor a 0");
            const b = toBaseQty(qty, unit, ing.base_unit);
            planned.push({ ingredientId: ing.id, qtyBase: b.qty, sort: sort++ });
            r.normalized = {
              ...mr.values,
              product_id: product.id,
              ingredient_id: ing.id,
              qty_base: b.qty,
              base_unit: ing.base_unit,
            };
          } catch (e) {
            r.action = "error";
            r.error = (e as Error).message;
            failed = true;
          }
        }
        results.push(r);
      }
      if (failed) {
        for (const r of results)
          if (r.action !== "error") {
            r.action = "error";
            r.error = `Receta de «${productName}» no se importa: otra fila de la misma receta tiene error`;
          }
        units.push({ key: `recipe-${productName}`, rows: results });
        continue;
      }
      const yieldQty = grp
        .map((m) => num(m.values.yield_qty))
        .find((v): v is number => v !== null && v > 0);
      const labor =
        grp.map((m) => num(m.values.labor_cents)).find((v): v is number => v !== null) ?? null;
      const overhead =
        grp.map((m) => num(m.values.overhead_cents)).find((v): v is number => v !== null) ?? null;
      const yieldLabel =
        grp.map((m) => str(m.values.yield_label)).find((v): v is string => v !== null) ?? null;
      const notes =
        grp.map((m) => str(m.values.notes)).find((v): v is string => v !== null) ?? null;
      const cur = existing.get(product.id);
      const curLines = cur ? (lines.get(cur.id) ?? new Map<string, number>()) : null;
      let changed = !cur;
      if (cur && curLines) {
        const newYield = yieldQty ?? Number(cur.yield_qty);
        if (newYield !== Number(cur.yield_qty)) changed = true;
        if (labor !== null && labor !== cur.labor_cents) changed = true;
        if (overhead !== null && overhead !== cur.overhead_cents) changed = true;
        if (curLines.size !== planned.length) changed = true;
        for (const p of planned) if (curLines.get(p.ingredientId) !== p.qtyBase) changed = true;
      }
      const action = !cur ? "created" : changed ? "updated" : "matched";
      for (const r of results) {
        r.action = action;
        r.targetId = cur?.id ?? null;
        if (!yieldQty && !cur)
          r.warnings.push(
            "Sin rendimiento: se asume 1 pieza por receta (revisa el costo por pieza)",
          );
      }
      units.push({
        key: `recipe-${productName}`,
        rows: results,
        apply: async (trx) => {
          let recipeId = cur?.id;
          if (!recipeId) {
            const ins = await sql<{
              id: string;
            }>`insert into recipes(product_id, yield_qty, yield_label, labor_cents, overhead_cents, notes)
                   values (${product.id}, ${yieldQty ?? 1}, ${yieldLabel}, ${labor ?? 0}, ${overhead ?? 0}, ${notes}) returning id`.execute(
              trx,
            );
            recipeId = ins.rows[0]!.id;
          } else if (changed) {
            await sql`update recipes set yield_qty = coalesce(${yieldQty}, yield_qty), yield_label = coalesce(${yieldLabel}, yield_label),
                      labor_cents = coalesce(${labor}, labor_cents), overhead_cents = coalesce(${overhead}, overhead_cents),
                      notes = coalesce(${notes}, notes), version = version + 1 where id = ${recipeId}`.execute(
              trx,
            );
          }
          if (changed) {
            const ids = planned.map((p) => p.ingredientId);
            await sql`delete from recipe_items where recipe_id = ${recipeId} and ingredient_id <> all(${ids}::uuid[])`.execute(
              trx,
            );
            for (const p of planned) {
              await sql`insert into recipe_items(recipe_id, ingredient_id, qty, sort_order) values (${recipeId}, ${p.ingredientId}, ${p.qtyBase}, ${p.sort})
                        on conflict (recipe_id, ingredient_id) do update set qty = excluded.qty, sort_order = excluded.sort_order`.execute(
                trx,
              );
            }
          }
          return { targetId: recipeId, action };
        },
      });
    }
    return units;
  },
};
