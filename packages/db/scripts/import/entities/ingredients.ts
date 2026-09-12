/** Ingredientes: alta + precio histórico (precio, contenido, unidad → unidad base). */
import { normalizeUnit, toBaseQty } from "@pdp/domain";
import { sql } from "kysely";
import { normalizeName } from "../normalize.ts";
import type { EntityHandler, WorkUnit } from "../types.ts";
import {
  errorUnit,
  loadIngredients,
  localTs,
  mappedErrors,
  num,
  resolveByName,
  rowFrom,
  similarReason,
  skippedUnit,
  str,
} from "./common.ts";

type LatestPrice = { ingredient_id: string; price_cents: number; package_qty: string };

export const ingredients: EntityHandler = {
  entity: "ingredients",
  fields: {
    name: {
      transform: "text",
      required: true,
      help: "Nombre del ingrediente (columna Ingrediente)",
    },
    brand: { transform: "text", help: "Marca (opcional)" },
    price_cents: { transform: "money", help: "Precio de compra del paquete (Precio)" },
    package_qty: { transform: "qty", help: "Contenido del paquete (Contenido)" },
    unit: { transform: "unit", help: "Unidad del contenido: g, kg, ml, l, pz, docena (Unidad)" },
    package_label: { transform: "text", help: "Presentación, ej. 'Caja 1.808 kg'" },
    supplier: { transform: "text", help: "Proveedor (se crea si no existe)" },
    min_stock_qty: { transform: "qty", help: "Stock mínimo en la unidad de la columna Unidad" },
    valid_from: { transform: "date", help: "Fecha desde la que rige el precio (default: hoy)" },
    notes: { transform: "text", help: "Notas" },
  },
  async plan(rows, ctx) {
    const existing = await loadIngredients(ctx.db);
    const latest = new Map<string, LatestPrice>();
    for (const p of (
      await sql<LatestPrice>`select distinct on (ingredient_id) ingredient_id, price_cents, package_qty::text as package_qty
                               from ingredient_prices order by ingredient_id, valid_from desc`.execute(
        ctx.db,
      )
    ).rows)
      latest.set(p.ingredient_id, p);
    const seen = new Map<string, number>();
    const units: WorkUnit[] = [];
    for (const mr of rows) {
      const bad = mappedErrors(mr);
      if (bad) {
        units.push(bad);
        continue;
      }
      const name = str(mr.values.name)!;
      const brand = str(mr.values.brand);
      const unitRaw = str(mr.values.unit) ?? ctx.options.default_unit ?? null;
      const price = num(mr.values.price_cents);
      const pkg = num(mr.values.package_qty);
      const key = normalizeName(name) + "|" + normalizeName(brand ?? "");
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
      if ((price === null) !== (pkg === null)) {
        units.push(errorUnit(mr, "Precio y Contenido deben venir juntos (o ninguno)", mr.values));
        continue;
      }
      if (pkg !== null && pkg <= 0) {
        units.push(errorUnit(mr, "El contenido debe ser mayor a 0", mr.values));
        continue;
      }
      const res = resolveByName(
        name,
        existing,
        (i) => i.name,
        ctx,
        (i) =>
          normalizeName(i.name) === normalizeName(name) &&
          normalizeName(i.brand ?? "") === normalizeName(brand ?? ""),
      );
      // Unidad base
      let base: "g" | "ml" | "pz" | null = null;
      let pkgBase: number | null = null;
      let minBase: number | null = null;
      try {
        if (unitRaw) {
          const u = normalizeUnit(unitRaw);
          if (!u) throw new Error(`Unidad desconocida: ${unitRaw}`);
          base = u.base;
          if (pkg !== null) pkgBase = toBaseQty(pkg, unitRaw).qty;
          const min = num(mr.values.min_stock_qty);
          if (min !== null) minBase = toBaseQty(min, unitRaw).qty;
        }
      } catch (e) {
        units.push(errorUnit(mr, (e as Error).message, mr.values));
        continue;
      }
      const existingBase = res.kind === "exact" ? res.item.base_unit : null;
      if (!base && !existingBase) {
        units.push(
          errorUnit(
            mr,
            'Falta la unidad (columna Unidad u options.default_unit: "g" | "ml" | "pz")',
            mr.values,
          ),
        );
        continue;
      }
      if (base && existingBase && base !== existingBase) {
        units.push(
          errorUnit(
            mr,
            `Unidad incompatible: el ingrediente existe en ${existingBase} y la fila viene en ${base}`,
            mr.values,
          ),
        );
        continue;
      }
      const normalized = {
        name,
        brand,
        base_unit: base ?? existingBase,
        package_qty_base: pkgBase,
        price_cents: price,
        package_label: str(mr.values.package_label),
        supplier: str(mr.values.supplier),
        min_stock_qty_base: minBase,
        valid_from: str(mr.values.valid_from),
        notes: str(mr.values.notes),
      };
      if (res.kind === "similar" && ctx.options.similar_policy === "skip") {
        units.push(skippedUnit(mr, similarReason(name, res.item.name, res.score), normalized));
        continue;
      }
      if (res.kind === "exact") {
        const cur = latest.get(res.item.id);
        const samePrice =
          price === null ||
          (cur !== undefined && cur.price_cents === price && Number(cur.package_qty) === pkgBase);
        const row = rowFrom(mr, samePrice ? "matched" : "updated", normalized);
        row.targetId = res.item.id;
        const id = res.item.id;
        units.push({
          key: `row-${mr.rowNumber}`,
          rows: [row],
          apply: async (trx) => {
            if (!samePrice) {
              await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents, package_label, valid_from, source, created_by)
                        values (${id}, ${pkgBase}, ${price}, ${normalized.package_label},
                                coalesce(${normalized.valid_from ? localTs(normalized.valid_from, "00:00") : null}, now()), 'import', current_staff_id())`.execute(
                trx,
              );
            }
            return { targetId: id, action: samePrice ? "matched" : "updated" };
          },
        });
        continue;
      }
      const row = rowFrom(mr, "created", normalized);
      units.push({
        key: `row-${mr.rowNumber}`,
        rows: [row],
        apply: async (trx) => {
          let supplierId: string | null = null;
          if (normalized.supplier) {
            const s = await sql<{
              id: string;
            }>`select id from suppliers where lower(name) = lower(${normalized.supplier}) limit 1`.execute(
              trx,
            );
            supplierId =
              s.rows[0]?.id ??
              (
                await sql<{
                  id: string;
                }>`insert into suppliers(name) values (${normalized.supplier}) returning id`.execute(
                  trx,
                )
              ).rows[0]!.id;
          }
          const ins = await sql<{
            id: string;
          }>`insert into ingredients(name, brand, supplier_id, base_unit, min_stock_qty, notes)
                 values (${name}, ${brand}, ${supplierId}, ${normalized.base_unit}::base_unit, ${minBase ?? 0}, ${normalized.notes}) returning id`.execute(
            trx,
          );
          const id = ins.rows[0]!.id;
          if (price !== null) {
            await sql`insert into ingredient_prices(ingredient_id, supplier_id, package_qty, price_cents, package_label, valid_from, source, created_by)
                      values (${id}, ${supplierId}, ${pkgBase}, ${price}, ${normalized.package_label},
                              coalesce(${normalized.valid_from ? localTs(normalized.valid_from, "00:00") : null}, now()), 'import', current_staff_id())`.execute(
              trx,
            );
          }
          return { targetId: id, action: "created" };
        },
      });
    }
    return units;
  },
};
