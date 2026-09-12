/** Precios de venta: nuevo precio regular cierra el anterior; promos con vigencia. */
import { sql } from "kysely";
import { normalizeName } from "../normalize.ts";
import type { EntityHandler, WorkUnit } from "../types.ts";
import { errorUnit, loadProducts, localTs, mappedErrors, num, rowFrom, str } from "./common.ts";

type Current = {
  id: string;
  product_id: string;
  channel: string;
  price_cents: number;
  valid_from: Date;
};
const CHANNELS: Record<string, "all" | "web" | "pos"> = {
  all: "all",
  todos: "all",
  ambos: "all",
  general: "all",
  "": "all",
  web: "web",
  online: "web",
  tienda: "web",
  "en linea": "web",
  "en línea": "web",
  pos: "pos",
  mostrador: "pos",
  caja: "pos",
  local: "pos",
};

export const prices: EntityHandler = {
  entity: "prices",
  fields: {
    product: { transform: "text", required: true, help: "Producto (Producto)" },
    price_cents: { transform: "money", required: true, help: "Precio de venta (Precio)" },
    channel: {
      transform: "text",
      help: "Canal: all | web | pos (default options.default_price_channel o all)",
    },
    kind: { transform: "text", help: "regular | promo (default regular)" },
    valid_from: { transform: "date", help: "Vigente desde (default: hoy)" },
    valid_to: { transform: "date", help: "Vigente hasta (promos)" },
    label: { transform: "text", help: "Etiqueta, ej. 'Promo San Valentín'" },
  },
  async plan(rows, ctx) {
    const products = await loadProducts(ctx.db);
    const current = new Map<string, Current>();
    for (const c of (
      await sql<Current>`select distinct on (product_id, channel) id, product_id, channel::text as channel, price_cents, valid_from
                         from product_prices where kind = 'regular' and valid_to is null order by product_id, channel, valid_from desc`.execute(
        ctx.db,
      )
    ).rows)
      current.set(`${c.product_id}|${c.channel}`, c);
    const seen = new Map<string, number>();
    const units: WorkUnit[] = [];
    for (const mr of rows) {
      const bad = mappedErrors(mr);
      if (bad) {
        units.push(bad);
        continue;
      }
      const productName = str(mr.values.product)!;
      const price = num(mr.values.price_cents)!;
      if (price < 0) {
        units.push(errorUnit(mr, "Precio negativo", mr.values));
        continue;
      }
      const chRaw = normalizeName(
        str(mr.values.channel) ?? ctx.options.default_price_channel ?? "all",
      );
      const channel = CHANNELS[chRaw];
      if (!channel) {
        units.push(
          errorUnit(
            mr,
            `Canal desconocido "${str(mr.values.channel)}" (usa all, web o pos)`,
            mr.values,
          ),
        );
        continue;
      }
      const kindRaw = normalizeName(str(mr.values.kind) ?? "regular");
      const kind = kindRaw.startsWith("promo")
        ? "promo"
        : kindRaw === "regular" || kindRaw === ""
          ? "regular"
          : null;
      if (!kind) {
        units.push(
          errorUnit(
            mr,
            `Tipo desconocido "${str(mr.values.kind)}" (usa regular o promo)`,
            mr.values,
          ),
        );
        continue;
      }
      const product = products.find(
        (p) =>
          normalizeName(p.name) === normalizeName(productName) ||
          p.slug === normalizeName(productName).replace(/ /g, "-"),
      );
      if (!product) {
        units.push(
          errorUnit(
            mr,
            `Producto «${productName}» no existe. Importa productos antes que precios.`,
            mr.values,
          ),
        );
        continue;
      }
      const key = `${product.id}|${channel}|${kind}`;
      if (seen.has(key)) {
        units.push(
          errorUnit(
            mr,
            `Producto «${productName}» repetido para el mismo canal (fila ${seen.get(key)})`,
            mr.values,
          ),
        );
        continue;
      }
      seen.set(key, mr.rowNumber);
      const validFrom = str(mr.values.valid_from);
      const validTo = str(mr.values.valid_to);
      if (validFrom && validTo && validTo <= validFrom) {
        units.push(errorUnit(mr, "La fecha 'hasta' debe ser posterior a 'desde'", mr.values));
        continue;
      }
      const normalized = {
        product_id: product.id,
        product: product.name,
        price_cents: price,
        channel,
        kind,
        valid_from: validFrom,
        valid_to: validTo,
        label: str(mr.values.label),
      };
      const fromExpr = validFrom ? localTs(validFrom, "00:00") : sql`now()`;
      const toExpr = validTo ? localTs(validTo, "23:59:59") : sql`null::timestamptz`;
      if (kind === "regular") {
        const cur = current.get(`${product.id}|${channel}`);
        if (cur && cur.price_cents === price) {
          const row = rowFrom(mr, "matched", normalized);
          row.targetId = cur.id;
          units.push({
            key: `row-${mr.rowNumber}`,
            rows: [row],
            apply: async () => ({ targetId: cur.id, action: "matched" }),
          });
          continue;
        }
        if (cur && validFrom && new Date(validFrom + "T23:59:59Z") < cur.valid_from) {
          units.push(
            errorUnit(
              mr,
              `La fecha 'desde' (${validFrom}) es anterior al precio vigente (${cur.valid_from.toISOString().slice(0, 10)})`,
              normalized,
            ),
          );
          continue;
        }
        const row = rowFrom(mr, cur ? "updated" : "created", normalized);
        units.push({
          key: `row-${mr.rowNumber}`,
          rows: [row],
          apply: async (trx) => {
            const ins = await sql<{
              id: string;
              valid_from: Date;
            }>`insert into product_prices(product_id, channel, kind, price_cents, valid_from, label, created_by)
                   values (${product.id}, ${channel}::price_channel, 'regular', ${price}, ${fromExpr}, ${normalized.label}, current_staff_id()) returning id, valid_from`.execute(
              trx,
            );
            const created = ins.rows[0]!;
            if (cur) {
              await sql`update product_prices set valid_to = ${created.valid_from} where id = ${cur.id} and valid_from < ${created.valid_from}`.execute(
                trx,
              );
            }
            current.set(`${product.id}|${channel}`, {
              id: created.id,
              product_id: product.id,
              channel,
              price_cents: price,
              valid_from: created.valid_from,
            });
            return { targetId: created.id, action: cur ? "updated" : "created" };
          },
        });
        continue;
      }
      // promo
      const row = rowFrom(mr, "created", normalized);
      if (!validTo)
        row.warnings.push("Promo sin fecha 'hasta': quedará vigente hasta que se cierre a mano");
      units.push({
        key: `row-${mr.rowNumber}`,
        rows: [row],
        apply: async (trx) => {
          const dup = await sql<{
            id: string;
          }>`select id from product_prices where product_id = ${product.id} and channel = ${channel}::price_channel and kind = 'promo'
                 and price_cents = ${price} and valid_from = ${fromExpr} limit 1`.execute(trx);
          if (dup.rows[0]) return { targetId: dup.rows[0].id, action: "matched" };
          const ins = await sql<{
            id: string;
          }>`insert into product_prices(product_id, channel, kind, price_cents, valid_from, valid_to, label, created_by)
                 values (${product.id}, ${channel}::price_channel, 'promo', ${price}, ${fromExpr}, ${toExpr}, ${normalized.label}, current_staff_id()) returning id`.execute(
            trx,
          );
          return { targetId: ins.rows[0]!.id, action: "created" };
        },
      });
    }
    return units;
  },
};
