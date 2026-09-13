/**
 * Pedidos históricos (ventas pasadas). Formato ancho (una fila por pedido, una columna por producto)
 * o largo (una fila por producto; se agrupa por cliente+fecha). Cada pedido → import_historical_sale(jsonb):
 * pedido + ítems + venta + pago, sin inventario ni puntos, idempotente por source_ref.
 */
import { sql } from "kysely";
import { callFn } from "../../../src/index.ts";
import { headerKey, normHeader } from "../mapping.ts";
import { normalizeName } from "../normalize.ts";
import { toMoneyCents, toQty, toText } from "../transforms.ts";
import {
  ImportError,
  type EntityHandler,
  type MappedRow,
  type RowResult,
  type WorkUnit,
} from "../types.ts";
import {
  bool,
  loadCustomers,
  loadProducts,
  num,
  rowFrom,
  str,
  type CustomerRow,
  type ProductRow,
} from "./common.ts";

const METHODS: Array<[RegExp, string]> = [
  [/efectivo|cash|contado/, "cash"],
  [/transf|spei|dep[oó]sito|banco/, "transfer"],
  [/mercado ?pago|\bmp\b|link/, "mercadopago"],
  [/tarjeta|terminal|card|tpv|clip/, "card_terminal"],
];
function paymentMethod(raw: string | null): string {
  const s = normalizeName(raw ?? "");
  if (!s) return "cash";
  for (const [re, m] of METHODS) if (re.test(s)) return m;
  return "other";
}

/** Celda por nombre de encabezado ignorando mayúsculas, acentos y espacios (las claves de `raw` son las de la hoja). */
function rawCell(raw: Record<string, string>, header: string): string {
  if (raw[header] !== undefined) return raw[header]!;
  const n = normHeader(header);
  const k = Object.keys(raw).find((x) => normHeader(x) === n);
  return k === undefined ? "" : (raw[k] ?? "");
}

type Item = {
  product: ProductRow;
  qty: number;
  unit_price_cents: number | null;
  unit_cost_cents: number | null;
};
type Group = { rows: MappedRow[]; items: Item[]; errors: string[] };

export const orders: EntityHandler = {
  entity: "orders",
  fields: {
    customer: { transform: "text", required: true, help: "Nombre del cliente (Cliente)" },
    phone: { transform: "phone", help: "Teléfono del cliente" },
    email: { transform: "text", help: "Email del cliente" },
    date: { transform: "date", required: true, help: "Fecha del pedido/venta (Fecha)" },
    pickup_point: {
      transform: "text",
      help: "Punto de entrega (se enlaza por nombre o queda como nota)",
    },
    paid: { transform: "bool", help: "Pagado sí/no (default sí)" },
    payment_method: { transform: "text", help: "Efectivo, transferencia, Mercado Pago, tarjeta" },
    payment_reference: { transform: "text", help: "Referencia del pago" },
    total_cents: {
      transform: "money",
      help: "Total declarado en la hoja (se concilia con los ítems)",
    },
    discount_cents: { transform: "money", help: "Descuento" },
    delivery_fee_cents: { transform: "money", help: "Costo de envío" },
    notes: { transform: "text", help: "Notas del pedido" },
    channel: { transform: "text", help: "pos | web | admin | instagram | whatsapp" },
    fulfillment_type: {
      transform: "text",
      help: "pickup | scheduled_pickup | delivery | preorder",
    },
  },
  async plan(rows, ctx) {
    const items = ctx.mapping.items;
    if (!items) throw new ImportError('Pedidos: el mapeo necesita "items" (mode wide o long)');
    const products = await loadProducts(ctx.db);
    const customers = await loadCustomers(ctx.db);
    const currentPrice = new Map(
      (
        await sql<{
          id: string;
          p: number | null;
        }>`select id, coalesce(current_price_cents(id, 'pos'), current_price_cents(id, 'all')) as p from products where deleted_at is null`.execute(
          ctx.db,
        )
      ).rows.map((r) => [r.id, r.p]),
    );
    const findProduct = (name: string) => {
      const n = normalizeName(name);
      return (
        products.find((p) => normalizeName(p.name) === n || p.slug === n.replace(/ /g, "-")) ?? null
      );
    };
    const usedHeaders = new Set(Object.values(ctx.mapping.columns).map((c) => normHeader(c.from)));
    const opts = ctx.mapping.options ?? {};

    // 1) Construir grupos (pedidos)
    const groups: Group[] = [];
    if (items.mode === "wide") {
      const allHeaders = rows[0] ? Object.keys(rows[0].raw) : [];
      const exclude = new Set((items.exclude ?? []).map((h) => normHeader(h)));
      const productHeaders =
        items.product_columns === "auto"
          ? allHeaders.filter((h) => !usedHeaders.has(normHeader(h)) && !exclude.has(normHeader(h)))
          : items.product_columns;
      for (const mr of rows) {
        const g: Group = { rows: [mr], items: [], errors: [...mr.errors] };
        for (const h of productHeaders) {
          const cell = rawCell(mr.raw, h);
          let qty: number | null = null;
          try {
            qty = toQty(cell, opts);
          } catch (e) {
            g.errors.push(`${h}: ${(e as Error).message}`);
            continue;
          }
          if (!qty) continue;
          const p = findProduct(h);
          if (!p) {
            g.errors.push(
              `La columna «${h}» no corresponde a ningún producto (crea el producto, corrige el encabezado o agrégala a items.exclude)`,
            );
            continue;
          }
          g.items.push({ product: p, qty, unit_price_cents: null, unit_cost_cents: null });
        }
        groups.push(g);
      }
    } else {
      const groupBy = items.group_by ?? ["customer", "date"];
      const byKey = new Map<string, Group>();
      for (const mr of rows) {
        const key = groupBy.map((f) => normalizeName(String(mr.values[f] ?? ""))).join("|");
        let g = byKey.get(key);
        if (!g) {
          g = { rows: [], items: [], errors: [] };
          byKey.set(key, g);
          groups.push(g);
        }
        g.rows.push(mr);
        g.errors.push(...mr.errors.map((e) => `fila ${mr.rowNumber}: ${e}`));
        const pName = toText(rawCell(mr.raw, items.product));
        let qty: number | null = null;
        let price: number | null = null;
        let cost: number | null = null;
        try {
          qty = toQty(rawCell(mr.raw, items.qty), opts);
          if (items.unit_price) price = toMoneyCents(rawCell(mr.raw, items.unit_price), opts);
          if (items.unit_cost) cost = toMoneyCents(rawCell(mr.raw, items.unit_cost), opts);
        } catch (e) {
          g.errors.push(`fila ${mr.rowNumber}: ${(e as Error).message}`);
          continue;
        }
        if (!pName || !qty) continue;
        const p = findProduct(pName);
        if (!p) {
          g.errors.push(`fila ${mr.rowNumber}: producto «${pName}» no existe`);
          continue;
        }
        const dup = g.items.find((i) => i.product.id === p.id);
        if (dup) dup.qty += qty;
        else g.items.push({ product: p, qty, unit_price_cents: price, unit_cost_cents: cost });
      }
    }

    // 2) Decidir cada grupo
    const declaredTotals = groups
      .map((g) => num(g.rows[0]!.values.total_cents))
      .filter((v): v is number => v !== null);
    const existingImported = (
      await sql<{
        folio: string;
        customer_name: string | null;
        total_cents: number;
        day: string;
        source_ref: string;
      }>`
        select folio, customer_name, total_cents, to_char(placed_at at time zone (select timezone from business_settings where id = 1), 'YYYY-MM-DD') as day, source_ref
        from orders where source_ref like 'import:%' and total_cents = any(${declaredTotals}::int[])`.execute(
        ctx.db,
      )
    ).rows;
    const bySourceRef = new Map(
      (
        await sql<{
          id: string;
          source_ref: string;
        }>`select id, source_ref from orders where source_ref like ${"import:" + ctx.importKey + ":%"}`.execute(
          ctx.db,
        )
      ).rows.map((r) => [r.source_ref, r.id]),
    );
    const registeredInRun = new Map<string, string>(); // phone/email → customer_id (clientes creados en esta corrida)
    const units: WorkUnit[] = [];
    for (const g of groups) {
      const first = g.rows[0]!;
      const results: RowResult[] = g.rows.map((mr) => rowFrom(mr, "created", mr.values));
      const fail = (msg: string) => {
        for (const r of results) {
          r.action = "error";
          r.error = msg;
        }
        units.push({ key: `order-${first.rowNumber}`, rows: results });
      };
      if (g.errors.length) {
        fail(g.errors.join(" · "));
        continue;
      }
      const customerName = str(first.values.customer)!;
      const date = str(first.values.date)!;
      if (g.items.length === 0) {
        for (const r of results) {
          r.action = "skipped";
          r.error = "Sin productos con cantidad";
        }
        units.push({ key: `order-${first.rowNumber}`, rows: results });
        continue;
      }
      const phone = str(first.values.phone);
      const email = str(first.values.email)?.toLowerCase() ?? null;
      const sourceRef = `import:${ctx.importKey}:${first.rowNumber}`;
      const declared = num(first.values.total_cents);
      const paid = bool(first.values.paid) ?? true;
      const warnings: string[] = [];

      // Pre-validación del total (la SQL vuelve a validar con el precio vigente en la fecha de la venta)
      const missingPrice = g.items.find(
        (i) => i.unit_price_cents === null && (currentPrice.get(i.product.id) ?? null) === null,
      );
      if (missingPrice) {
        fail(`Producto «${missingPrice.product.name}» sin precio en la hoja ni en el catálogo`);
        continue;
      }
      const estimated =
        g.items.reduce(
          (s, i) => s + Math.round((i.unit_price_cents ?? currentPrice.get(i.product.id)!) * i.qty),
          0,
        ) +
        (num(first.values.delivery_fee_cents) ?? 0) -
        (num(first.values.discount_cents) ?? 0);
      if (declared !== null && declared > estimated) {
        fail(
          `El total declarado ($${(declared / 100).toFixed(2)}) es mayor a la suma de los ítems ($${(estimated / 100).toFixed(2)}); revisa precios o cantidades`,
        );
        continue;
      }
      if (declared !== null && declared < estimated)
        warnings.push(
          `Total declarado menor a la suma de ítems: la diferencia ($${((estimated - declared) / 100).toFixed(2)}) se registra como descuento`,
        );

      // Cliente: teléfono/email exacto → nombre exacto único → registrar (si hay contacto) → solo snapshot
      let customer: CustomerRow | null =
        customers.find(
          (c) => (phone && c.phone === phone) || (email && c.email?.toLowerCase() === email),
        ) ?? null;
      let registerNew = false;
      if (!customer) {
        const byName = customers.filter(
          (c) => normalizeName(c.full_name) === normalizeName(customerName),
        );
        if (byName.length === 1 && !phone && !email) customer = byName[0]!;
        else if (byName.length > 1)
          warnings.push(
            `Hay ${byName.length} clientes llamados «${customerName}»; el pedido se guarda sin enlazar al cliente`,
          );
        else if ((phone || email) && ctx.options.create_missing_customers) registerNew = true;
        else
          warnings.push(
            `Cliente «${customerName}» no encontrado (sin teléfono/email para registrarlo); el pedido guarda solo el nombre`,
          );
      }

      // Idempotencia: ya importado con la misma clave de archivo
      const existingId = bySourceRef.get(sourceRef);
      if (existingId) {
        for (const r of results) {
          r.action = "matched";
          r.targetId = existingId;
          r.warnings.push("Ya importado en una corrida anterior del mismo archivo");
        }
        units.push({
          key: `order-${first.rowNumber}`,
          rows: results,
          apply: async () => ({ targetId: existingId, action: "matched" }),
        });
        continue;
      }
      // Dedupe secundario: mismo día + mismo total declarado + mismo nombre, importado desde otro archivo
      if (declared !== null) {
        const twin = existingImported.find(
          (o) =>
            o.day === date &&
            o.total_cents === declared &&
            normalizeName(o.customer_name ?? "") === normalizeName(customerName) &&
            !o.source_ref.startsWith(`import:${ctx.importKey}:`),
        );
        if (twin) {
          for (const r of results) {
            r.action = "skipped";
            r.error = `Ya existe un pedido importado equivalente (${twin.folio}: ${date}, mismo cliente y total). No se duplica.`;
          }
          units.push({ key: `order-${first.rowNumber}`, rows: results });
          continue;
        }
      }

      const payload = {
        source_ref: sourceRef,
        sold_date: date,
        channel: str(first.values.channel)
          ? normalizeName(str(first.values.channel)!)
          : (opts.default_channel ?? "admin"),
        fulfillment_type: str(first.values.fulfillment_type)
          ? normalizeName(str(first.values.fulfillment_type)!).replace(/ /g, "_")
          : "pickup",
        customer_id: customer?.id ?? null,
        customer_name: customerName,
        customer_phone: phone,
        customer_email: email,
        pickup_point_name: str(first.values.pickup_point),
        paid,
        payment_method: paymentMethod(str(first.values.payment_method)),
        payment_reference: str(first.values.payment_reference),
        total_cents: declared,
        discount_cents: num(first.values.discount_cents) ?? 0,
        delivery_fee_cents: num(first.values.delivery_fee_cents) ?? 0,
        notes: str(first.values.notes),
        items: g.items.map((i) => ({
          product_id: i.product.id,
          product_name: i.product.name,
          qty: i.qty,
          unit_price_cents: i.unit_price_cents,
          unit_cost_cents: i.unit_cost_cents,
        })),
      };
      if (registerNew) warnings.push(`Se registrará al cliente «${customerName}» (source=import)`);
      if (!paid) warnings.push("Pago pendiente: se crea el pedido confirmado sin venta ni pago");
      for (const r of results) {
        r.normalized = payload;
        r.warnings.push(...warnings);
      }
      units.push({
        key: `order-${first.rowNumber}`,
        rows: results,
        apply: async (trx) => {
          let customerId = payload.customer_id;
          if (registerNew) {
            const cached =
              (phone && registeredInRun.get(phone)) ||
              (email && registeredInRun.get(email)) ||
              null;
            if (cached) customerId = cached;
            else {
              const r = await callFn<{ customer_id: string }>(trx, "register_customer", [
                JSON.stringify({ full_name: customerName, phone, email, source: "import" }),
              ]);
              customerId = r.customer_id;
              if (phone) registeredInRun.set(phone, customerId);
              if (email) registeredInRun.set(email, customerId);
            }
          }
          const res = await callFn<{ order_id: string; duplicate: boolean }>(
            trx,
            "import_historical_sale",
            [JSON.stringify({ ...payload, customer_id: customerId })],
          );
          return { targetId: res.order_id, action: res.duplicate ? "matched" : "created" };
        },
      });
    }
    return units;
  },
};

export { headerKey };
