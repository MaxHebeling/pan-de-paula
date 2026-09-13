import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { isManager, TODAY } from "@/lib/ops";
import { PageHeader, Card, Table, Badge, Alert, EmptyState, Money } from "@/components/ui";
import { Tabs } from "@/components/ops/tabs";
import { UnreadBadge } from "@/components/ops/unread-badge";
import { ActionForm } from "@/components/ops/action-form";
import { PendingButton } from "@/components/ops/pending-button";
import { Field } from "@/components/ops/field";
import { WASTE_REASONS, containsPattern, expectedClosing } from "@pdp/domain";
import { fmtDate, qty, todayLocal } from "@/lib/format";
import {
  adjustAction,
  applyCountAction,
  createCountAction,
  discardCountAction,
  rebuildLevelsAction,
  saveCountItemsAction,
  wasteAction,
} from "./actions";

export const metadata = { title: "Inventario" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | undefined>;
const TABS = [
  { key: "stock", label: "Stock" },
  { key: "movimientos", label: "Movimientos" },
  { key: "mermas", label: "Mermas" },
  { key: "conteo", label: "Conteo físico" },
  { key: "conciliacion", label: "Conciliación" },
  { key: "insumos", label: "Insumos" },
];
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isUuid = (s: string | undefined): s is string =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const MOVEMENT_LABELS: Record<string, string> = {
  INITIAL: "Inicial",
  PRODUCTION: "Producción",
  SALE: "Venta",
  WASTE: "Merma",
  CORRECTION: "Corrección",
  RETURN: "Devolución",
  GIFT: "Regalo",
  INTERNAL_USE: "Consumo interno",
  TRANSFER: "Traslado",
  VOID: "Anulación",
};
const WASTE_LABEL = Object.fromEntries(WASTE_REASONS.map((r) => [r.key, r.label])) as Record<
  string,
  string
>;

export default async function InventarioPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession("inventory.read");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "stock";
  const canWrite = hasPermission(session, "inventory.write");
  const manager = isManager(session) && canWrite;
  const d = db();
  const [counts, openCount] = await Promise.all([
    sql<{ out: number; low: number; ing: number }>`
      select (select count(*)::int from stock_status where track_stock and level = 'out') as out,
             (select count(*)::int from stock_status where track_stock and level = 'low') as low,
             (select count(*)::int from ingredients where deleted_at is null and min_stock_qty > 0 and stock_qty <= min_stock_qty) as ing`.execute(
      d,
    ),
    sql<{ n: number }>`select count(*)::int as n from stock_counts where status = 'open'`.execute(
      d,
    ),
  ]);
  const c = counts.rows[0]!;
  return (
    <>
      <PageHeader
        title="Inventario"
        subtitle="Stock por movimientos: cada entrada y salida queda registrada y es conciliable."
        actions={
          <>
            <UnreadBadge />
            {manager && (
              <ActionForm
                action={rebuildLevelsAction}
                className="flex flex-col items-end gap-1"
                resetOnSuccess={false}
              >
                <PendingButton
                  className="btn btn-secondary"
                  pendingLabel="Reconstruyendo…"
                  confirm="¿Reconstruir los niveles de inventario desde los movimientos? Corrige cualquier desfase del nivel materializado; no altera el historial."
                >
                  Reconstruir niveles
                </PendingButton>
              </ActionForm>
            )}
          </>
        }
      />
      <Tabs
        base="/inventario"
        current={tab}
        items={TABS.map((t) => ({
          ...t,
          count:
            t.key === "stock"
              ? c.out + c.low
              : t.key === "insumos"
                ? c.ing
                : t.key === "conteo"
                  ? openCount.rows[0]!.n
                  : undefined,
        }))}
      />
      {tab === "stock" && <StockTab q={sp.q ?? ""} canWrite={canWrite} />}
      {tab === "movimientos" && <MovementsTab sp={sp} />}
      {tab === "mermas" && (
        <WasteTab rango={sp.rango === "semana" ? "semana" : "dia"} canWrite={canWrite} />
      )}
      {tab === "conteo" && <CountTab sp={sp} canWrite={canWrite} />}
      {tab === "conciliacion" && <ReconciliationTab sp={sp} />}
      {tab === "insumos" && <IngredientsTab />}
    </>
  );
}

async function productOptions() {
  const r = await sql<{ id: string; name: string }>`
    select id, name from products where deleted_at is null and is_active order by name`.execute(
    db(),
  );
  return r.rows;
}

function ProductSelect({
  products,
  name = "product_id",
  id,
  defaultValue,
}: {
  products: Array<{ id: string; name: string }>;
  name?: string;
  id: string;
  defaultValue?: string;
}) {
  return (
    <select
      id={id}
      name={name}
      className="input min-h-11"
      defaultValue={defaultValue ?? ""}
      required
    >
      <option value="">Elige un producto</option>
      {products.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/* ── Stock ─────────────────────────────────────────────────────────────── */
async function StockTab({ q, canWrite }: { q: string; canWrite: boolean }) {
  const rows = await sql<{
    product_id: string;
    name: string;
    category_name: string | null;
    track_stock: boolean;
    on_hand: string;
    level: "ok" | "low" | "out";
    low_stock_threshold: string;
    updated_at: Date | null;
  }>`select s.product_id, s.name, c.name as category_name, s.track_stock, s.on_hand::text, s.level, s.low_stock_threshold::text, s.updated_at
     from stock_status s left join categories c on c.id = s.category_id
     where (${q} = '' or s.name ilike ${containsPattern(q)})
     order by s.track_stock desc, case s.level when 'out' then 0 when 'low' then 1 else 2 end, c.sort_order nulls last, s.name`.execute(
    db(),
  );
  return (
    <>
      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <input type="hidden" name="tab" value="stock" />
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="q">
            Buscar producto
          </label>
          <input
            id="q"
            name="q"
            type="search"
            className="input min-h-11"
            defaultValue={q}
            placeholder="Nombre…"
          />
        </div>
        <button className="btn btn-secondary min-h-11">Buscar</button>
      </form>
      {rows.rows.length === 0 ? (
        <EmptyState title="Sin productos" body="No hay productos activos que coincidan." />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Categoría</th>
              <th className="text-right">Existencia</th>
              <th>Nivel</th>
              <th>Actualizado</th>
              {canWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((r) => (
              <tr
                key={r.product_id}
                data-testid={`stock-row-${r.product_id}`}
                data-product-name={r.name}
              >
                <td className="font-medium">{r.name}</td>
                <td className="text-muted">{r.category_name ?? "—"}</td>
                <td
                  className="text-right text-base font-semibold tabular-nums"
                  data-testid="stock-on-hand"
                >
                  {qty(r.on_hand)}
                </td>
                <td>
                  {!r.track_stock ? (
                    <Badge tone="gray">Sin control</Badge>
                  ) : r.level === "out" ? (
                    <Badge tone="red">Agotado</Badge>
                  ) : r.level === "low" ? (
                    <Badge tone="amber">Bajo (≤ {qty(r.low_stock_threshold)})</Badge>
                  ) : (
                    <Badge tone="green">OK</Badge>
                  )}
                </td>
                <td className="text-muted">
                  {r.updated_at ? fmtDate(r.updated_at, "datetime") : "—"}
                </td>
                {canWrite && (
                  <td>
                    <details className="group">
                      <summary className="btn btn-secondary btn-sm min-h-9 cursor-pointer list-none">
                        Ajustar
                      </summary>
                      <div className="mt-2 w-80 max-w-[80vw] rounded-[var(--r-card)] border border-line bg-bg p-3">
                        <ActionForm action={adjustAction} className="flex flex-col gap-2">
                          <input type="hidden" name="product_id" value={r.product_id} />
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Tipo" htmlFor={`mode-${r.product_id}`}>
                              <select
                                id={`mode-${r.product_id}`}
                                name="mode"
                                className="input min-h-11"
                                defaultValue="waste"
                              >
                                <option value="waste">Merma</option>
                                <option value="correction">Corrección</option>
                              </select>
                            </Field>
                            <Field label="Cantidad" htmlFor={`qty-${r.product_id}`}>
                              <input
                                id={`qty-${r.product_id}`}
                                name="qty"
                                type="number"
                                step="0.001"
                                min="0.001"
                                className="input min-h-11"
                                required
                              />
                            </Field>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Sentido (corrección)" htmlFor={`dir-${r.product_id}`}>
                              <select
                                id={`dir-${r.product_id}`}
                                name="direction"
                                className="input min-h-11"
                                defaultValue="remove"
                              >
                                <option value="remove">Restar</option>
                                <option value="add">Sumar</option>
                              </select>
                            </Field>
                            <Field label="Motivo" htmlFor={`reason-${r.product_id}`}>
                              <select
                                id={`reason-${r.product_id}`}
                                name="reason"
                                className="input min-h-11"
                                defaultValue="difference"
                              >
                                <optgroup label="Merma">
                                  {WASTE_REASONS.map((w) => (
                                    <option key={w.key} value={w.key}>
                                      {w.label}
                                    </option>
                                  ))}
                                </optgroup>
                                <optgroup label="Corrección">
                                  <option value="difference">Diferencia</option>
                                  <option value="error">Error de captura</option>
                                  <option value="initial">Inventario inicial</option>
                                  <option value="other">Otro</option>
                                </optgroup>
                              </select>
                            </Field>
                          </div>
                          <input
                            name="note"
                            className="input min-h-11"
                            placeholder="Nota (opcional)"
                            maxLength={300}
                          />
                          <PendingButton className="btn btn-primary min-h-11">
                            Aplicar ajuste
                          </PendingButton>
                        </ActionForm>
                      </div>
                    </details>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

/* ── Movimientos ───────────────────────────────────────────────────────── */
async function MovementsTab({ sp }: { sp: Search }) {
  const producto = isUuid(sp.producto) ? sp.producto : null;
  const tipo = sp.tipo && sp.tipo in MOVEMENT_LABELS ? sp.tipo : null;
  const desde = isDate(sp.desde) ? sp.desde : null;
  const hasta = isDate(sp.hasta) ? sp.hasta : null;
  const page = Math.max(1, Number(sp.pagina ?? 1) || 1);
  const limit = 100;
  const [rows, products] = await Promise.all([
    sql<{
      id: number;
      occurred_at: Date;
      product_id: string;
      product_name: string;
      type: string;
      qty: string;
      ref_type: string | null;
      ref_id: string | null;
      reason: string | null;
      note: string | null;
      staff_name: string | null;
      order_id: string | null;
      folio: string | null;
      lot_code: string | null;
    }>`select m.id, m.occurred_at, m.product_id, p.name as product_name, m.type::text, m.qty::text, m.ref_type, m.ref_id, m.reason, m.note,
              s.full_name as staff_name,
              coalesce(sa.order_id, rt.order_id) as order_id, o.folio, pb.lot_code
       from inventory_movements m
       join products p on p.id = m.product_id
       left join staff_users s on s.id = m.staff_id
       left join sales sa on m.ref_type = 'sale' and sa.id::text = m.ref_id
       left join returns rt on m.ref_type = 'return' and rt.id::text = m.ref_id
       left join orders o on o.id = coalesce(sa.order_id, rt.order_id)
       left join production_batches pb on m.ref_type = 'production_batch' and pb.id::text = m.ref_id
       where (${producto}::uuid is null or m.product_id = ${producto}::uuid)
         and (${tipo}::text is null or m.type::text = ${tipo}::text)
         and (${desde}::date is null or (m.occurred_at at time zone (select timezone from business_settings where id = 1))::date >= ${desde}::date)
         and (${hasta}::date is null or (m.occurred_at at time zone (select timezone from business_settings where id = 1))::date <= ${hasta}::date)
       order by m.occurred_at desc, m.id desc
       limit ${limit + 1} offset ${(page - 1) * limit}`.execute(db()),
    productOptions(),
  ]);
  const hasMore = rows.rows.length > limit;
  const list = rows.rows.slice(0, limit);
  const keep = {
    tab: "movimientos",
    producto: producto ?? "",
    tipo: tipo ?? "",
    desde: desde ?? "",
    hasta: hasta ?? "",
  };
  const pageHref = (p: number) =>
    `/inventario?${new URLSearchParams({ ...keep, pagina: String(p) }).toString()}`;
  const refLink = (r: (typeof list)[number]) => {
    if (r.order_id) return { href: `/pedidos/${r.order_id}`, label: r.folio ?? "Pedido" };
    if (r.ref_type === "production_batch")
      return {
        href: `/produccion?tab=lotes&fecha=${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tijuana" }).format(r.occurred_at)}&producto=${r.product_id}`,
        label: r.lot_code ?? "Lote",
      };
    if (r.ref_type === "stock_count")
      return { href: `/inventario?tab=conteo&conteo=${r.ref_id}`, label: "Conteo" };
    if (r.ref_type === "waste_record")
      return { href: `/inventario?tab=mermas&rango=semana`, label: "Merma" };
    return null;
  };
  return (
    <>
      <form className="card mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-5" method="get">
        <input type="hidden" name="tab" value="movimientos" />
        <Field label="Producto" htmlFor="producto">
          <select
            id="producto"
            name="producto"
            className="input min-h-11"
            defaultValue={producto ?? ""}
          >
            <option value="">Todos</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo" htmlFor="tipo">
          <select id="tipo" name="tipo" className="input min-h-11" defaultValue={tipo ?? ""}>
            <option value="">Todos</option>
            {Object.entries(MOVEMENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Desde" htmlFor="desde">
          <input
            id="desde"
            name="desde"
            type="date"
            className="input min-h-11"
            defaultValue={desde ?? ""}
          />
        </Field>
        <Field label="Hasta" htmlFor="hasta">
          <input
            id="hasta"
            name="hasta"
            type="date"
            className="input min-h-11"
            defaultValue={hasta ?? ""}
          />
        </Field>
        <div className="flex items-end">
          <button className="btn btn-secondary min-h-11 w-full">Filtrar</button>
        </div>
      </form>
      {list.length === 0 ? (
        <EmptyState
          title="Sin movimientos"
          body="Ajusta los filtros o registra producción, ventas o mermas."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Producto</th>
              <th>Tipo</th>
              <th className="text-right">Cantidad</th>
              <th>Motivo / nota</th>
              <th>Referencia</th>
              <th>Staff</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const link = refLink(r);
              const n = Number(r.qty);
              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtDate(r.occurred_at, "datetime")}
                  </td>
                  <td className="font-medium">{r.product_name}</td>
                  <td>
                    <Badge tone={n > 0 ? "green" : r.type === "SALE" ? "blue" : "amber"}>
                      {MOVEMENT_LABELS[r.type] ?? r.type}
                    </Badge>
                  </td>
                  <td
                    className={`text-right font-semibold tabular-nums ${n < 0 ? "text-red-d" : "text-green-d"}`}
                  >
                    {n > 0 ? "+" : ""}
                    {qty(r.qty)}
                  </td>
                  <td className="text-muted">
                    {r.reason ? (WASTE_LABEL[r.reason] ?? r.reason) : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </td>
                  <td>
                    {link ? (
                      <Link href={link.href} className="underline">
                        {link.label}
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="text-muted">{r.staff_name ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {(page > 1 || hasMore) && (
        <div className="mt-3 flex justify-between">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="btn btn-secondary">
              ← Anteriores
            </Link>
          ) : (
            <span />
          )}
          {hasMore && (
            <Link href={pageHref(page + 1)} className="btn btn-secondary">
              Siguientes →
            </Link>
          )}
        </div>
      )}
    </>
  );
}

/* ── Mermas ────────────────────────────────────────────────────────────── */
async function WasteTab({ rango, canWrite }: { rango: "dia" | "semana"; canWrite: boolean }) {
  const [products, list] = await Promise.all([
    productOptions(),
    sql<{
      id: string;
      occurred_at: Date;
      product_name: string;
      qty: string;
      reason: string;
      note: string | null;
      staff_name: string | null;
      cost_cents: number | null;
    }>`select w.id, w.occurred_at, p.name as product_name, w.qty::text, w.reason, w.note, s.full_name as staff_name,
              case when w.cost_cents_snapshot is null then null else round(w.cost_cents_snapshot * w.qty)::int end as cost_cents
       from waste_records w join products p on p.id = w.product_id left join staff_users s on s.id = w.staff_id
       where (w.occurred_at at time zone (select timezone from business_settings where id = 1))::date >= ${TODAY} - ${rango === "semana" ? 6 : 0}::int
       order by w.occurred_at desc`.execute(db()),
  ]);
  const totalQty = list.rows.reduce((a, r) => a + Number(r.qty), 0);
  const totalCost = list.rows.reduce((a, r) => a + (r.cost_cents ?? 0), 0);
  const missingCost = list.rows.some((r) => r.cost_cents === null);
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
      {canWrite && (
        <Card title="Registrar merma">
          <ActionForm action={wasteAction}>
            <Field label="Producto" htmlFor="w-product">
              <ProductSelect products={products} id="w-product" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cantidad" htmlFor="w-qty">
                <input
                  id="w-qty"
                  name="qty"
                  type="number"
                  step="0.001"
                  min="0.001"
                  inputMode="decimal"
                  className="input min-h-12 text-lg"
                  required
                />
              </Field>
              <Field label="Motivo" htmlFor="w-reason">
                <select
                  id="w-reason"
                  name="reason"
                  className="input min-h-12"
                  defaultValue="burnt"
                  required
                >
                  {WASTE_REASONS.map((w) => (
                    <option key={w.key} value={w.key}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Nota" htmlFor="w-note">
              <input
                id="w-note"
                name="note"
                className="input min-h-11"
                maxLength={300}
                placeholder="Opcional"
              />
            </Field>
            <PendingButton className="btn btn-primary min-h-12" pendingLabel="Registrando…">
              Registrar merma
            </PendingButton>
          </ActionForm>
        </Card>
      )}
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 rounded-[var(--r-btn)] bg-black/5 p-1">
            {(["dia", "semana"] as const).map((r) => (
              <Link
                key={r}
                href={`/inventario?tab=mermas&rango=${r}`}
                className={`min-h-9 rounded-[var(--r-btn-sm)] px-3 py-1.5 text-sm font-semibold ${rango === r ? "bg-card shadow-[var(--shadow)]" : "text-muted"}`}
              >
                {r === "dia" ? "Hoy" : "Últimos 7 días"}
              </Link>
            ))}
          </div>
          <p className="text-sm text-muted">
            {list.rows.length} registros · {qty(totalQty)} piezas · costo estimado{" "}
            <Money cents={totalCost} />
            {missingCost && " (algunos sin receta)"}
          </p>
        </div>
        {list.rows.length === 0 ? (
          <EmptyState title="Sin mermas en el periodo" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th className="text-right">Cantidad</th>
                <th>Motivo</th>
                <th className="text-right">Costo est.</th>
                <th>Staff</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap tabular-nums">
                    {fmtDate(r.occurred_at, "datetime")}
                  </td>
                  <td className="font-medium">{r.product_name}</td>
                  <td className="text-right tabular-nums">{qty(r.qty)}</td>
                  <td>
                    <Badge tone="amber">{WASTE_LABEL[r.reason] ?? r.reason}</Badge>
                    {r.note && <span className="ml-2 text-muted">{r.note}</span>}
                  </td>
                  <td className="text-right">
                    {r.cost_cents === null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <Money cents={r.cost_cents} />
                    )}
                  </td>
                  <td className="text-muted">{r.staff_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

/* ── Conteo físico (wizard) ────────────────────────────────────────────── */
async function CountTab({ sp, canWrite }: { sp: Search; canWrite: boolean }) {
  const d = db();
  const open = await sql<{
    id: string;
    started_at: Date;
    notes: string | null;
    staff_name: string | null;
  }>`
    select sc.id, sc.started_at, sc.notes, s.full_name as staff_name from stock_counts sc left join staff_users s on s.id = sc.staff_id
    where sc.status = 'open' order by sc.started_at desc limit 1`.execute(d);
  const current = open.rows[0] ?? null;
  const viewing = isUuid(sp.conteo) ? sp.conteo : (current?.id ?? null);
  const paso = sp.paso === "revisar" ? "revisar" : "capturar";
  const history = await sql<{
    id: string;
    started_at: Date;
    closed_at: Date | null;
    status: string;
    staff_name: string | null;
    notes: string | null;
    items: number;
    diffs: number;
  }>`select sc.id, sc.started_at, sc.closed_at, sc.status, s.full_name as staff_name, sc.notes,
            (select count(*)::int from stock_count_items i where i.stock_count_id = sc.id) as items,
            (select count(*)::int from stock_count_items i where i.stock_count_id = sc.id and i.difference_qty <> 0) as diffs
     from stock_counts sc left join staff_users s on s.id = sc.staff_id
     order by sc.started_at desc limit 20`.execute(d);
  const items = viewing
    ? await sql<{
        product_id: string;
        name: string;
        expected_qty: string;
        counted_qty: string;
        difference_qty: string;
        note: string | null;
        status: string;
      }>`select i.product_id, p.name, i.expected_qty::text, i.counted_qty::text, i.difference_qty::text, i.note, sc.status
         from stock_count_items i join products p on p.id = i.product_id join stock_counts sc on sc.id = i.stock_count_id
         where i.stock_count_id = ${viewing} order by p.name`.execute(d)
    : null;
  const viewingOpen = !!current && viewing === current.id;

  return (
    <div className="flex flex-col gap-4">
      {sp.aplicado !== undefined && (
        <Alert tone="green">
          Conteo aplicado: {sp.aplicado} corrección(es) registradas en inventario.
        </Alert>
      )}
      {sp.descartado && <Alert tone="gray">Conteo descartado. El inventario no cambió.</Alert>}

      {!current && canWrite && (
        <Card title="Iniciar conteo físico">
          <p className="mb-3 text-sm text-muted">
            Paso 1 de 3 · Se precarga la existencia esperada de todos los productos con control de
            stock. Después capturas lo contado, revisas diferencias y aplicas.
          </p>
          <ActionForm action={createCountAction} className="flex flex-wrap items-end gap-3">
            <Field label="Notas" htmlFor="c-notes" className="min-w-64 flex-1">
              <input
                id="c-notes"
                name="notes"
                className="input min-h-11"
                placeholder="Ej. conteo de cierre de semana"
                maxLength={300}
              />
            </Field>
            <PendingButton className="btn btn-primary min-h-11" pendingLabel="Creando…">
              Crear conteo
            </PendingButton>
          </ActionForm>
        </Card>
      )}

      {items && viewing && viewingOpen && paso === "capturar" && (
        <Card
          title="Paso 2 de 3 · Capturar cantidades"
          action={
            <span className="text-sm text-muted">
              Iniciado {fmtDate(current!.started_at, "datetime")} · {current!.staff_name ?? ""}
            </span>
          }
        >
          <ActionForm action={saveCountItemsAction} resetOnSuccess={false}>
            <input type="hidden" name="stock_count_id" value={viewing} />
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="text-right">Esperado</th>
                  <th className="w-40">Contado</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {items.rows.map((it) => (
                  <tr key={it.product_id}>
                    <td className="font-medium">{it.name}</td>
                    <td className="text-right tabular-nums">{qty(it.expected_qty)}</td>
                    <td>
                      <input
                        name={`counted_${it.product_id}`}
                        type="number"
                        step="0.001"
                        min="0"
                        inputMode="decimal"
                        className="input min-h-12 text-right text-lg tabular-nums"
                        defaultValue={Math.max(0, Number(it.counted_qty))}
                        aria-label={`Contado de ${it.name}`}
                        disabled={!canWrite}
                      />
                    </td>
                    <td>
                      <input
                        name={`note_${it.product_id}`}
                        className="input min-h-11"
                        defaultValue={it.note ?? ""}
                        maxLength={200}
                        placeholder="Opcional"
                        disabled={!canWrite}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {canWrite && (
              <div className="flex flex-wrap justify-end gap-2">
                <PendingButton className="btn btn-primary min-h-12" pendingLabel="Guardando…">
                  Guardar y revisar diferencias →
                </PendingButton>
              </div>
            )}
          </ActionForm>
          {canWrite && (
            <ActionForm
              action={discardCountAction}
              className="mt-3 flex justify-start"
              resetOnSuccess={false}
            >
              <input type="hidden" name="stock_count_id" value={viewing} />
              <PendingButton
                className="btn btn-danger min-h-11"
                confirm="¿Descartar este conteo? No se aplicará ninguna corrección."
              >
                Descartar conteo
              </PendingButton>
            </ActionForm>
          )}
        </Card>
      )}

      {items && viewing && viewingOpen && paso === "revisar" && (
        <Card title="Paso 3 de 3 · Revisar diferencias y aplicar">
          {(() => {
            const diffs = items.rows.filter((i) => Number(i.difference_qty) !== 0);
            return diffs.length === 0 ? (
              <p className="text-sm text-muted">
                No hay diferencias: lo contado coincide con lo esperado. Puedes cerrar el conteo
                aplicándolo (sin correcciones) o descartarlo.
              </p>
            ) : (
              <Table className="!border-0 !shadow-none">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="text-right">Esperado</th>
                    <th className="text-right">Contado</th>
                    <th className="text-right">Diferencia</th>
                    <th>Nota</th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.map((it) => {
                    const diff = Number(it.difference_qty);
                    return (
                      <tr key={it.product_id}>
                        <td className="font-medium">{it.name}</td>
                        <td className="text-right tabular-nums">{qty(it.expected_qty)}</td>
                        <td className="text-right tabular-nums">{qty(it.counted_qty)}</td>
                        <td
                          className={`text-right font-semibold tabular-nums ${diff < 0 ? "text-red-d" : "text-green-d"}`}
                        >
                          {diff > 0 ? "+" : ""}
                          {qty(it.difference_qty)}
                        </td>
                        <td className="text-muted">{it.note ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            );
          })()}
          {canWrite && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <Link
                href={`/inventario?tab=conteo&conteo=${viewing}&paso=capturar`}
                className="btn btn-secondary min-h-11"
              >
                ← Volver a capturar
              </Link>
              <div className="flex gap-2">
                <ActionForm action={discardCountAction} resetOnSuccess={false}>
                  <input type="hidden" name="stock_count_id" value={viewing} />
                  <PendingButton
                    className="btn btn-danger min-h-11"
                    confirm="¿Descartar este conteo? No se aplicará ninguna corrección."
                  >
                    Descartar
                  </PendingButton>
                </ActionForm>
                <ActionForm action={applyCountAction} resetOnSuccess={false}>
                  <input type="hidden" name="stock_count_id" value={viewing} />
                  <PendingButton
                    className="btn btn-confirm min-h-11"
                    pendingLabel="Aplicando…"
                    confirm="¿Aplicar el conteo? Se registrarán movimientos de corrección por cada diferencia."
                  >
                    Aplicar correcciones
                  </PendingButton>
                </ActionForm>
              </div>
            </div>
          )}
        </Card>
      )}

      {items && viewing && !viewingOpen && (
        <Card
          title={`Detalle del conteo · ${items.rows[0]?.status === "applied" ? "aplicado" : items.rows[0]?.status === "discarded" ? "descartado" : ""}`}
        >
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-right">Esperado</th>
                <th className="text-right">Contado</th>
                <th className="text-right">Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {items.rows.map((it) => (
                <tr key={it.product_id}>
                  <td>{it.name}</td>
                  <td className="text-right tabular-nums">{qty(it.expected_qty)}</td>
                  <td className="text-right tabular-nums">{qty(it.counted_qty)}</td>
                  <td className="text-right tabular-nums">{qty(it.difference_qty)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card title="Historial de conteos">
        {history.rows.length === 0 ? (
          <p className="text-sm text-muted">Aún no hay conteos.</p>
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Inicio</th>
                <th>Cierre</th>
                <th>Estado</th>
                <th className="text-right">Productos</th>
                <th className="text-right">Diferencias</th>
                <th>Staff</th>
                <th>Notas</th>
              </tr>
            </thead>
            <tbody>
              {history.rows.map((h) => (
                <tr key={h.id}>
                  <td>
                    <Link href={`/inventario?tab=conteo&conteo=${h.id}`} className="underline">
                      {fmtDate(h.started_at, "datetime")}
                    </Link>
                  </td>
                  <td className="text-muted">
                    {h.closed_at ? fmtDate(h.closed_at, "datetime") : "—"}
                  </td>
                  <td>
                    <Badge
                      tone={
                        h.status === "applied" ? "green" : h.status === "open" ? "amber" : "gray"
                      }
                    >
                      {h.status === "applied"
                        ? "Aplicado"
                        : h.status === "open"
                          ? "Abierto"
                          : "Descartado"}
                    </Badge>
                  </td>
                  <td className="text-right tabular-nums">{h.items}</td>
                  <td className="text-right tabular-nums">{h.diffs}</td>
                  <td className="text-muted">{h.staff_name ?? "—"}</td>
                  <td className="text-muted">{h.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/* ── Conciliación ──────────────────────────────────────────────────────── */
function weekStart(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function ReconciliationTab({ sp }: { sp: Search }) {
  const today = todayLocal();
  const desde = isDate(sp.desde) ? sp.desde : weekStart(today);
  const hasta = isDate(sp.hasta) ? sp.hasta : today;
  const rows = await sql<{
    product_id: string;
    product_name: string;
    opening: string;
    production: string;
    sales: string;
    waste: string;
    corrections: string;
    other: string;
    closing: string;
  }>`select product_id, product_name, opening::text, production::text, sales::text, waste::text, corrections::text, other::text, closing::text
     from inventory_reconciliation(
       (${desde}::date)::timestamp at time zone (select timezone from business_settings where id = 1),
       ((${hasta}::date + 1)::timestamp) at time zone (select timezone from business_settings where id = 1))`.execute(
    db(),
  );
  const active = rows.rows.filter((r) =>
    [r.opening, r.production, r.sales, r.waste, r.corrections, r.other, r.closing].some(
      (v) => Number(v) !== 0,
    ),
  );
  const sum = (k: keyof (typeof rows.rows)[number]) => active.reduce((a, r) => a + Number(r[k]), 0);
  const exportHref = `/inventario/conciliacion/export?desde=${desde}&hasta=${hasta}`;
  return (
    <>
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-4" method="get">
        <input type="hidden" name="tab" value="conciliacion" />
        <Field label="Desde" htmlFor="desde">
          <input
            id="desde"
            name="desde"
            type="date"
            className="input min-h-11"
            defaultValue={desde}
          />
        </Field>
        <Field label="Hasta" htmlFor="hasta">
          <input
            id="hasta"
            name="hasta"
            type="date"
            className="input min-h-11"
            defaultValue={hasta}
          />
        </Field>
        <button className="btn btn-secondary min-h-11">Conciliar</button>
        <a href={exportHref} className="btn btn-secondary ml-auto min-h-11" download>
          Exportar CSV
        </a>
      </form>
      <p className="mb-3 text-sm text-muted">
        Cierre = apertura + producción − ventas − mermas ± correcciones ± otros (devoluciones,
        anulaciones, inicial). Se resalta cualquier fila cuyo cierre no cuadre.
      </p>
      {active.length === 0 ? (
        <EmptyState title="Sin movimientos en el rango" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Producto</th>
              <th className="text-right">Apertura</th>
              <th className="text-right">Producción</th>
              <th className="text-right">Ventas</th>
              <th className="text-right">Mermas</th>
              <th className="text-right">Correcciones</th>
              <th className="text-right">Otros</th>
              <th className="text-right">Cierre</th>
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const expected = expectedClosing({
                opening: Number(r.opening),
                production: Number(r.production),
                sales: Number(r.sales),
                waste: Number(r.waste),
                corrections: Number(r.corrections),
                other: Number(r.other),
              });
              const mismatch = Math.abs(expected - Number(r.closing)) > 0.0005;
              return (
                <tr
                  key={r.product_id}
                  className={mismatch ? "st-red" : ""}
                  data-testid={`recon-row-${r.product_id}`}
                  data-product-name={r.product_name}
                >
                  <td className="font-medium">{r.product_name}</td>
                  <td className="text-right tabular-nums">{qty(r.opening)}</td>
                  <td
                    className="text-right tabular-nums text-green-d"
                    data-testid="recon-production"
                  >
                    {qty(r.production)}
                  </td>
                  <td className="text-right tabular-nums">{qty(r.sales)}</td>
                  <td className="text-right tabular-nums text-amber-d" data-testid="recon-waste">
                    {qty(r.waste)}
                  </td>
                  <td className="text-right tabular-nums">{qty(r.corrections)}</td>
                  <td className="text-right tabular-nums">{qty(r.other)}</td>
                  <td className="text-right font-semibold tabular-nums">{qty(r.closing)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold">
              <td>Total</td>
              <td className="text-right tabular-nums">{qty(sum("opening"))}</td>
              <td className="text-right tabular-nums">{qty(sum("production"))}</td>
              <td className="text-right tabular-nums">{qty(sum("sales"))}</td>
              <td className="text-right tabular-nums">{qty(sum("waste"))}</td>
              <td className="text-right tabular-nums">{qty(sum("corrections"))}</td>
              <td className="text-right tabular-nums">{qty(sum("other"))}</td>
              <td className="text-right tabular-nums">{qty(sum("closing"))}</td>
            </tr>
          </tbody>
        </Table>
      )}
    </>
  );
}

/* ── Insumos ───────────────────────────────────────────────────────────── */
async function IngredientsTab() {
  const rows = await sql<{
    id: string;
    name: string;
    brand: string | null;
    base_unit: string;
    stock_qty: string;
    min_stock_qty: string;
    unit_cost: string | null;
    last_movement: Date | null;
  }>`select i.id, i.name, i.brand, i.base_unit::text, i.stock_qty::text, i.min_stock_qty::text,
            ingredient_unit_cost(i.id)::text as unit_cost,
            (select max(occurred_at) from ingredient_movements m where m.ingredient_id = i.id) as last_movement
     from ingredients i where i.deleted_at is null
     order by case when i.min_stock_qty > 0 and i.stock_qty <= 0 then 0 when i.min_stock_qty > 0 and i.stock_qty <= i.min_stock_qty then 1 else 2 end, i.name`.execute(
    db(),
  );
  return rows.rows.length === 0 ? (
    <EmptyState
      title="Sin insumos"
      body="Registra ingredientes en el catálogo para ver su stock aquí."
    />
  ) : (
    <Table>
      <thead>
        <tr>
          <th>Insumo</th>
          <th className="text-right">Stock</th>
          <th className="text-right">Mínimo</th>
          <th>Nivel</th>
          <th className="text-right">Costo unitario</th>
          <th>Último movimiento</th>
        </tr>
      </thead>
      <tbody>
        {rows.rows.map((r) => {
          const stock = Number(r.stock_qty);
          const min = Number(r.min_stock_qty);
          const level = min > 0 && stock <= 0 ? "out" : min > 0 && stock <= min ? "low" : "ok";
          return (
            <tr key={r.id}>
              <td className="font-medium">
                {r.name}
                {r.brand && <span className="text-muted"> · {r.brand}</span>}
              </td>
              <td className="text-right font-semibold tabular-nums">
                {qty(r.stock_qty)} {r.base_unit}
              </td>
              <td className="text-right tabular-nums text-muted">
                {min > 0 ? `${qty(r.min_stock_qty)} ${r.base_unit}` : "—"}
              </td>
              <td>
                {level === "out" ? (
                  <Badge tone="red">Agotado</Badge>
                ) : level === "low" ? (
                  <Badge tone="amber">Crítico</Badge>
                ) : (
                  <Badge tone="green">OK</Badge>
                )}
              </td>
              <td className="text-right tabular-nums text-muted">
                {r.unit_cost === null
                  ? "sin precio"
                  : `$${Number(r.unit_cost).toLocaleString("es-MX", { maximumFractionDigits: 4 })}/${r.base_unit}`}
              </td>
              <td className="text-muted">
                {r.last_movement ? fmtDate(r.last_movement, "datetime") : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
