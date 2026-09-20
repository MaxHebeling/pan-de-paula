import "server-only";
import { containsPattern, csvCell } from "@pdp/domain";
import { db, sql, callFn } from "./db";
import { todayLocal } from "./format";

export type Range = { from: string; to: string; prevFrom: string; prevTo: string; days: number };

const isDate = (s: string | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Rango desde searchParams (fechas locales YYYY-MM-DD, inclusivas) + periodo anterior de la misma longitud. */
export function parseRange(
  sp: Record<string, string | string[] | undefined>,
  defaults: { from: string; to: string },
): Range {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]);
  let from = isDate(one("from")) ? one("from")! : defaults.from;
  let to = isDate(one("to")) ? one("to")! : defaults.to;
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) > 366) from = shiftDate(to, -366);
  const days = daysBetween(from, to) + 1;
  return { from, to, prevFrom: shiftDate(from, -days), prevTo: shiftDate(to, -days), days };
}

export function defaultRanges() {
  const today = todayLocal();
  const monthStart = today.slice(0, 8) + "01";
  const [y, m] = today.split("-").map(Number) as [number, number];
  const prevMonthStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const prevMonthEnd = shiftDate(monthStart, -1);
  return { today, monthStart, prevMonthStart, prevMonthEnd, last30: shiftDate(today, -29) };
}

export type Summary = {
  from: string;
  to: string;
  sales: {
    count: number;
    gross_cents: number;
    subtotal_cents: number;
    discount_cents: number;
    tip_cents: number;
    units: string;
    cost_cents: number;
    cost_missing: number;
    ticket_cents: number;
    customers_buying: number;
    identified: number;
  };
  refunds_cents: number;
  net_cents: number;
  customers_new: number;
  orders: {
    count: number;
    web: number;
    pos: number;
    other: number;
    cancelled: number;
    open: number;
  };
  waste: { count: number; qty: string; cost_cents: number };
  production: { batches: number; qty: string; cost_cents: number };
  payments: Array<{ method: string; count: number; amount_cents: number; refunded_cents: number }>;
  channels: Array<{ channel: string; count: number; revenue_cents: number; units: string }>;
  inventory_units: string;
  register: { count: number; difference_cents: number; with_difference: number };
};

export const summary = (from: string, to: string) =>
  callFn<Summary>(db(), "report_summary", [from, to]);

export type DailyRow = {
  day: string;
  sales_count: number;
  revenue_cents: number;
  refunds_cents: number;
  units: string;
  waste_qty: string;
  production_qty: string;
  new_customers: number;
  cost_cents: number;
};
export const dailySeries = async (from: string, to: string) =>
  (
    await sql<DailyRow>`select day::text as day, sales_count, revenue_cents, refunds_cents, units, waste_qty, production_qty, new_customers, cost_cents from report_daily_series(${from}, ${to})`.execute(
      db(),
    )
  ).rows;

export type ProductRow = {
  product_id: string;
  product_name: string;
  category_name: string | null;
  produced: string;
  sold: string;
  waste: string;
  on_hand: string;
  revenue_cents: number;
  cost_cents: number | null;
  profit_cents: number | null;
  margin_bps: number | null;
  cost_missing: boolean;
};
export const products = async (from: string, to: string) =>
  (await sql<ProductRow>`select * from report_products(${from}, ${to})`.execute(db())).rows;

export type CustomersReport = {
  new: number;
  buying: number;
  recurring: number;
  returning: number;
  top: Array<{
    id: string;
    public_code: string;
    full_name: string;
    tier_key: string | null;
    sales: number;
    spent_cents: number;
    last_purchase_at: string;
  }>;
  tiers: Array<{
    tier_key: string;
    name: string;
    rank: number;
    customers: number;
    sales: number;
    spent_cents: number;
  }>;
  inactive_30: number;
  inactive_60: number;
  points: { issued: number; redeemed: number; adjusted: number; reversed: number };
  sources: Array<{ source: string; count: number }>;
  total_active: number;
  marketing_consent: number;
};
export const customers = (from: string, to: string) =>
  callFn<CustomersReport>(db(), "report_customers", [from, to]);

export type WasteRow = { reason: string; count: number; qty: string; cost_cents: number };
export const waste = async (from: string, to: string) =>
  (await sql<WasteRow>`select * from report_waste(${from}, ${to})`.execute(db())).rows;

export const wasteDetail = async (from: string, to: string) =>
  (
    await sql<{
      id: string;
      occurred_at: Date;
      product_name: string;
      qty: string;
      reason: string;
      note: string | null;
      staff_name: string | null;
      cost_cents: number;
    }>`
      with rr as (select * from report_range(${from}, ${to}))
      select w.id, w.occurred_at, p.name as product_name, w.qty, w.reason, w.note, su.full_name as staff_name, round(coalesce(w.cost_cents_snapshot, 0) * w.qty)::bigint as cost_cents
      from waste_records w join products p on p.id = w.product_id left join staff_users su on su.id = w.staff_id, rr
      where w.occurred_at >= rr.v_from and w.occurred_at < rr.v_to order by w.occurred_at desc limit 500`.execute(
      db(),
    )
  ).rows;

export type ReconRow = {
  product_id: string;
  product_name: string;
  opening: string;
  production: string;
  sales: string;
  waste: string;
  corrections: string;
  other: string;
  closing: string;
};
export const reconciliation = async (from: string, to: string) =>
  (
    await sql<ReconRow>`with rr as (select * from report_range(${from}, ${to})) select r.* from rr, inventory_reconciliation(rr.v_from, rr.v_to) r`.execute(
      db(),
    )
  ).rows;

export type RegisterRow = {
  id: string;
  opened_at: Date;
  closed_at: Date | null;
  status: string;
  opened_by: string;
  closed_by: string | null;
  opening_cash_cents: number;
  expected_cash_cents: number | null;
  counted_cash_cents: number | null;
  difference_cents: number | null;
  card_cents: number | null;
  transfer_cents: number | null;
  mercadopago_cents: number | null;
  other_cents: number | null;
  sales_count: number;
  sales_total_cents: number;
  notes: string | null;
};
export const registerSessions = async (from: string, to: string) =>
  (
    await sql<RegisterRow>`
      with rr as (select * from report_range(${from}, ${to}))
      select rs.id, rs.opened_at, rs.closed_at, rs.status, o.full_name as opened_by, c.full_name as closed_by, rs.opening_cash_cents, rs.expected_cash_cents,
             rs.counted_cash_cents, rs.difference_cents, rs.card_cents, rs.transfer_cents, rs.mercadopago_cents, rs.other_cents, rs.notes,
             (select count(*) from sales s where s.register_session_id = rs.id and s.voided_at is null)::int as sales_count,
             coalesce((select sum(total_cents) from sales s where s.register_session_id = rs.id and s.voided_at is null), 0)::bigint as sales_total_cents
      from register_sessions rs join staff_users o on o.id = rs.opened_by left join staff_users c on c.id = rs.closed_by, rr
      where rs.opened_at >= rr.v_from and rs.opened_at < rr.v_to order by rs.opened_at desc`.execute(
      db(),
    )
  ).rows;

export const topProducts = async (from: string, to: string, limit = 10) =>
  (
    await sql<{ product_name: string; units: string; revenue_cents: number }>`
      with rr as (select * from report_range(${from}, ${to}))
      select oi.product_name, sum(oi.qty)::numeric as units, sum(oi.total_cents)::bigint as revenue_cents
      from sales s join order_items oi on oi.order_id = s.order_id, rr
      where s.voided_at is null and s.sold_at >= rr.v_from and s.sold_at < rr.v_to
      group by oi.product_name order by revenue_cents desc limit ${limit}`.execute(db())
  ).rows;

/**
 * Detalle de PAGOS del periodo: una fila por pago, con su método, su monto y su REFERENCIA CONTABLE.
 *
 * Es el grano que pide la conciliación: los reportes agregados (canales, caja) suman por método y ahí la
 * referencia no existe. En una venta con varios pagos cada parte aparece en su propia fila, así que nunca
 * se pierde qué referencia va con qué método y con qué monto.
 * `metodo` y `ref` son los mismos filtros de la pantalla, para que el CSV exporte exactamente lo que se ve.
 */
export type PaymentDetailRow = {
  id: string;
  order_id: string;
  folio: string;
  created_at: Date;
  method: string;
  status: string;
  amount_cents: number;
  refunded_cents: number;
  reference: string | null;
  external_id: string | null;
  staff_name: string | null;
  voided_at: Date | null;
  customer_name: string | null;
};
export const paymentsDetail = async (
  from: string,
  to: string,
  opts: { metodo?: string; ref?: string; limit?: number } = {},
) => {
  const metodo = opts.metodo ?? "";
  const ref = opts.ref ?? "";
  return (
    await sql<PaymentDetailRow>`
      with rr as (select * from report_range(${from}, ${to}))
      select p.id, p.order_id, o.folio, p.created_at, p.method::text as method, p.status::text as status,
             p.amount_cents, p.reference, p.external_id, su.full_name as staff_name, s.voided_at, o.customer_name,
             coalesce((select sum(r.amount_cents) from refunds r where r.payment_id = p.id and r.status <> 'failed'), 0)::int as refunded_cents
      from payments p
      join orders o on o.id = p.order_id
      left join sales s on s.order_id = o.id
      left join staff_users su on su.id = p.received_by, rr
      where p.created_at >= rr.v_from and p.created_at < rr.v_to
        and p.status in ('paid','partially_refunded','refunded')
        and (${metodo} = '' or p.method::text = ${metodo})
        and (${ref} = '' or p.reference ilike ${containsPattern(ref)})
      order by p.created_at desc
      limit ${opts.limit ?? 2000}`.execute(db())
  ).rows;
};

export const inactiveCustomers = async (days: number, limit = 50) =>
  (
    await sql<{
      id: string;
      public_code: string;
      full_name: string;
      phone: string | null;
      last_purchase_at: Date;
      total_orders: number;
      total_spent_cents: number;
      tier_key: string | null;
    }>`
      select id, public_code, full_name, phone::text as phone, last_purchase_at, total_orders, total_spent_cents, tier_key
      from customers where deleted_at is null and merged_into_id is null and last_purchase_at < now() - (${days} || ' days')::interval
      order by total_spent_cents desc limit ${limit}`.execute(db())
  ).rows;

// ── Utilidades ──
export const PAYMENT_LABELS: Record<string, string> = {
  cash: "Efectivo",
  mercadopago: "Mercado Pago",
  card_terminal: "Terminal",
  transfer: "Transferencia",
  points: "Puntos",
  other: "Otro",
};
export const WASTE_LABELS: Record<string, string> = {
  burnt: "Quemado",
  broken: "Roto",
  expired: "Caducado",
  tasting: "Degustación",
  gift: "Regalo",
  courtesy: "Cortesía",
  internal_use: "Uso interno",
  error: "Error",
  difference: "Diferencia",
  other: "Otro",
};

export function delta(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export const pesos = (cents: number | string | null | undefined) =>
  cents === null || cents === undefined ? "" : (Number(cents) / 100).toFixed(2);

/** CSV con BOM (Excel en español lo abre bien) y separador coma. */
export function toCsv(
  columns: Array<{ key: string; label: string }>,
  rows: Array<Record<string, unknown>>,
): string {
  const esc = (v: unknown) => csvCell(v);
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(",")).join("\n");
  return "﻿" + head + "\n" + body + "\n";
}

export type ReportKind =
  | "diario"
  | "mensual"
  | "productos"
  | "clientes"
  | "canales"
  | "pagos"
  | "mermas"
  | "inventario"
  | "caja";
export const REPORT_KINDS: Array<{ key: ReportKind; label: string; href: string }> = [
  { key: "diario", label: "Diario", href: "/reportes" },
  { key: "mensual", label: "Mensual", href: "/reportes/mensual" },
  { key: "productos", label: "Rentabilidad por producto", href: "/reportes/productos" },
  { key: "clientes", label: "Clientes", href: "/reportes/clientes" },
  { key: "canales", label: "Canales y pagos", href: "/reportes/canales" },
  { key: "pagos", label: "Pagos y referencias", href: "/reportes/pagos" },
  { key: "mermas", label: "Mermas", href: "/reportes/mermas" },
  { key: "inventario", label: "Conciliación de inventario", href: "/reportes/inventario" },
  { key: "caja", label: "Caja", href: "/reportes/caja" },
];

/** Datos tabulares de cada reporte para exportación CSV. */
export async function exportRows(
  kind: ReportKind,
  from: string,
  to: string,
  filters: { metodo?: string; ref?: string } = {},
): Promise<{
  filename: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
}> {
  const name = `${kind}_${from}_${to}.csv`;
  switch (kind) {
    case "diario":
    case "mensual": {
      const rows = await dailySeries(from, to);
      return {
        filename: name,
        columns: [
          { key: "day", label: "Fecha" },
          { key: "sales_count", label: "Ventas" },
          { key: "revenue", label: "Ingresos (MXN)" },
          { key: "refunds", label: "Reembolsos (MXN)" },
          { key: "net", label: "Neto (MXN)" },
          { key: "cost", label: "Costo (MXN)" },
          { key: "units", label: "Unidades" },
          { key: "production_qty", label: "Producción (uds)" },
          { key: "waste_qty", label: "Merma (uds)" },
          { key: "new_customers", label: "Clientes nuevos" },
        ],
        rows: rows.map((r) => ({
          ...r,
          revenue: pesos(r.revenue_cents),
          refunds: pesos(r.refunds_cents),
          net: pesos(r.revenue_cents - r.refunds_cents),
          cost: pesos(r.cost_cents),
        })),
      };
    }
    case "productos": {
      const rows = await products(from, to);
      return {
        filename: name,
        columns: [
          { key: "product_name", label: "Producto" },
          { key: "category_name", label: "Categoría" },
          { key: "produced", label: "Producido" },
          { key: "sold", label: "Vendido" },
          { key: "waste", label: "Merma" },
          { key: "on_hand", label: "Stock actual" },
          { key: "revenue", label: "Ingresos (MXN)" },
          { key: "cost", label: "Costo (MXN)" },
          { key: "profit", label: "Utilidad (MXN)" },
          { key: "margin", label: "Margen %" },
        ],
        rows: rows.map((r) => ({
          ...r,
          revenue: pesos(r.revenue_cents),
          cost: pesos(r.cost_cents),
          profit: pesos(r.profit_cents),
          margin: r.margin_bps === null ? "" : (r.margin_bps / 100).toFixed(1),
        })),
      };
    }
    case "clientes": {
      const c = await customers(from, to);
      return {
        filename: name,
        columns: [
          { key: "public_code", label: "Código" },
          { key: "full_name", label: "Cliente" },
          { key: "tier_key", label: "Nivel" },
          { key: "sales", label: "Compras en periodo" },
          { key: "spent", label: "Gasto en periodo (MXN)" },
          { key: "last_purchase_at", label: "Última compra" },
        ],
        rows: c.top.map((t) => ({ ...t, spent: pesos(t.spent_cents) })),
      };
    }
    case "canales": {
      const s = await summary(from, to);
      return {
        filename: name,
        columns: [
          { key: "type", label: "Tipo" },
          { key: "name", label: "Nombre" },
          { key: "count", label: "Operaciones" },
          { key: "amount", label: "Monto (MXN)" },
          { key: "refunded", label: "Reembolsado (MXN)" },
        ],
        rows: [
          ...s.channels.map((c) => ({
            type: "Canal",
            name: c.channel,
            count: c.count,
            amount: pesos(c.revenue_cents),
            refunded: "",
          })),
          ...s.payments.map((p) => ({
            type: "Método de pago",
            name: PAYMENT_LABELS[p.method] ?? p.method,
            count: p.count,
            amount: pesos(p.amount_cents),
            refunded: pesos(p.refunded_cents),
          })),
        ],
      };
    }
    case "pagos": {
      const rows = await paymentsDetail(from, to, filters);
      return {
        filename: name,
        columns: [
          { key: "created_at", label: "Fecha" },
          { key: "folio", label: "Folio" },
          { key: "customer_name", label: "Cliente" },
          { key: "method_label", label: "Método" },
          { key: "reference_cell", label: "Referencia" },
          { key: "amount", label: "Monto (MXN)" },
          { key: "refunded", label: "Reembolsado (MXN)" },
          { key: "status", label: "Estado" },
          { key: "external_id", label: "ID Mercado Pago" },
          { key: "staff_name", label: "Registró" },
        ],
        rows: rows.map((r) => ({
          ...r,
          method_label: PAYMENT_LABELS[r.method] ?? r.method,
          // Sin referencia se exporta "—": el pago histórico no la tiene y no se inventa nada.
          reference_cell: r.reference ?? "—",
          amount: pesos(r.amount_cents),
          refunded: r.refunded_cents ? pesos(r.refunded_cents) : "",
        })),
      };
    }
    case "mermas": {
      const rows = await wasteDetail(from, to);
      return {
        filename: name,
        columns: [
          { key: "occurred_at", label: "Fecha" },
          { key: "product_name", label: "Producto" },
          { key: "qty", label: "Cantidad" },
          { key: "reason_label", label: "Motivo" },
          { key: "cost", label: "Costo (MXN)" },
          { key: "note", label: "Nota" },
          { key: "staff_name", label: "Registró" },
        ],
        rows: rows.map((r) => ({
          ...r,
          reason_label: WASTE_LABELS[r.reason] ?? r.reason,
          cost: pesos(r.cost_cents),
        })),
      };
    }
    case "inventario": {
      const rows = await reconciliation(from, to);
      return {
        filename: name,
        columns: [
          { key: "product_name", label: "Producto" },
          { key: "opening", label: "Inicial" },
          { key: "production", label: "Producción" },
          { key: "sales", label: "Ventas" },
          { key: "waste", label: "Mermas" },
          { key: "corrections", label: "Correcciones" },
          { key: "other", label: "Otros" },
          { key: "closing", label: "Final" },
        ],
        rows,
      };
    }
    case "caja": {
      const rows = await registerSessions(from, to);
      return {
        filename: name,
        columns: [
          { key: "opened_at", label: "Apertura" },
          { key: "closed_at", label: "Cierre" },
          { key: "opened_by", label: "Abrió" },
          { key: "closed_by", label: "Cerró" },
          { key: "sales_count", label: "Ventas" },
          { key: "sales_total", label: "Total ventas (MXN)" },
          { key: "opening_cash", label: "Fondo (MXN)" },
          { key: "expected", label: "Efectivo esperado (MXN)" },
          { key: "counted", label: "Efectivo contado (MXN)" },
          { key: "difference", label: "Diferencia (MXN)" },
          { key: "card", label: "Terminal (MXN)" },
          { key: "transfer", label: "Transferencia (MXN)" },
          { key: "mp", label: "Mercado Pago (MXN)" },
        ],
        rows: rows.map((r) => ({
          ...r,
          sales_total: pesos(r.sales_total_cents),
          opening_cash: pesos(r.opening_cash_cents),
          expected: pesos(r.expected_cash_cents),
          counted: pesos(r.counted_cash_cents),
          difference: pesos(r.difference_cents),
          card: pesos(r.card_cents),
          transfer: pesos(r.transfer_cents),
          mp: pesos(r.mercadopago_cents),
        })),
      };
    }
  }
}
