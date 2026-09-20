import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { TODAY } from "@/lib/ops";
import { PageHeader, Card, Table, Badge, Alert, EmptyState, LinkButton } from "@/components/ui";
import { Tabs } from "@/components/ops/tabs";
import { UnreadBadge } from "@/components/ops/unread-badge";
import { ProductionBoard, type BoardProduct } from "@/components/ops/production-board";
import {
  SpecialProductForm,
  SpecialProductList,
  type SpecialRow,
} from "@/components/ops/special-products";
import { PrintButton } from "@/components/ops/print-button";
import { PrintStyles } from "@/components/ops/print-styles";
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONE, type OrderStatus } from "@pdp/domain";
import { fmtDate, qty, todayLocal } from "@/lib/format";
import Link from "next/link";
import { setProductFlag, setProductPrice } from "../productos/actions";
import {
  createSpecialProduct,
  reactivateProduct,
  setSpecialName,
  setSpecialStock,
} from "./especiales-actions";

export const metadata = { title: "Producción" };
export const dynamic = "force-dynamic";

type Search = { tab?: string; fecha?: string; producto?: string };
const BASE_TABS = [
  { key: "hoy", label: "Producción del día" },
  { key: "lotes", label: "Lotes" },
  { key: "plan", label: "Plan" },
];
const SPECIAL_TAB = { key: "especiales", label: "Especiales" };
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function ProduccionPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession("production.read");
  const sp = await searchParams;
  // Los especiales son catálogo: ver la pestaña pide catalog.read; crear y editar, catalog.write.
  const canSeeSpecials = hasPermission(session, "catalog.read");
  const tabs = canSeeSpecials ? [...BASE_TABS, SPECIAL_TAB] : BASE_TABS;
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : "hoy";
  const canWrite = hasPermission(session, "production.write");
  const canCatalogWrite = hasPermission(session, "catalog.write");
  const canStock = hasPermission(session, "inventory.write");
  const d = db();

  const lowIngredients = await sql<{
    id: string;
    name: string;
    stock_qty: string;
    min_stock_qty: string;
    base_unit: string;
  }>`select id, name, stock_qty::text, min_stock_qty::text, base_unit::text
     from ingredients where deleted_at is null and min_stock_qty > 0 and stock_qty <= min_stock_qty order by name`.execute(
    d,
  );

  return (
    <>
      <PrintStyles />
      <PageHeader
        title="Producción"
        subtitle="Cada toque registra un lote y actualiza el inventario al instante."
        actions={
          <>
            {canSeeSpecials && canCatalogWrite && (
              <LinkButton href="/produccion?tab=especiales#nuevo-especial" variant="secondary">
                + Producto especial
              </LinkButton>
            )}
            <UnreadBadge />
          </>
        }
      />
      <div className="no-print">
        <Tabs base="/produccion" current={tab} items={tabs} />
      </div>
      {lowIngredients.rows.length > 0 && tab === "hoy" && (
        <div className="mb-4">
          <Alert tone="amber">
            <strong>Insumos bajo mínimo:</strong>{" "}
            {lowIngredients.rows
              .map(
                (i) =>
                  `${i.name} (${qty(i.stock_qty)} ${i.base_unit} / mín. ${qty(i.min_stock_qty)})`,
              )
              .join(" · ")}
            {" — "}
            <Link href="/inventario?tab=insumos" className="underline">
              ver insumos
            </Link>
          </Alert>
        </div>
      )}
      {tab === "hoy" && <TodayTab canWrite={canWrite} />}
      {tab === "lotes" && (
        <BatchesTab fecha={isDate(sp.fecha) ? sp.fecha : todayLocal()} producto={sp.producto} />
      )}
      {tab === "plan" && <PlanTab fecha={isDate(sp.fecha) ? sp.fecha : todayLocal()} />}
      {tab === "especiales" && canSeeSpecials && (
        <SpecialsTab canWrite={canCatalogWrite} canStock={canStock} />
      )}
    </>
  );
}

async function TodayTab({ canWrite }: { canWrite: boolean }) {
  const d = db();
  const [products, flag, settings] = await Promise.all([
    sql<{
      id: string;
      name: string;
      variant_label: string | null;
      unit_label: string;
      category_name: string | null;
      produced_today: string;
      on_hand: string;
      has_recipe: boolean;
    }>`select p.id, p.name, p.variant_label, p.unit_label, c.name as category_name,
              coalesce((select sum(b.qty) from production_batches b
                        where b.product_id = p.id and b.undone_at is null
                          and (b.produced_at at time zone (select timezone from business_settings where id = 1))::date = ${TODAY}), 0)::text as produced_today,
              coalesce(l.on_hand, 0)::text as on_hand,
              exists(select 1 from recipes r where r.product_id = p.id) as has_recipe
       from products p
       left join categories c on c.id = p.category_id
       left join inventory_levels l on l.product_id = p.id
       where p.deleted_at is null and p.is_active and p.track_stock
       order by c.sort_order nulls last, c.name nulls last, p.sort_order, p.name`.execute(d),
    sql<{
      enabled: boolean;
    }>`select enabled from feature_flags where key = 'ingredient_consumption'`.execute(d),
    sql<{
      low_stock_threshold: string;
    }>`select low_stock_threshold::text from business_settings where id = 1`.execute(d),
  ]);
  const list: BoardProduct[] = products.rows.map((p) => ({
    id: p.id,
    name: p.name,
    variant_label: p.variant_label,
    unit_label: p.unit_label,
    category_name: p.category_name ?? "Sin categoría",
    produced_today: Number(p.produced_today),
    on_hand: Number(p.on_hand),
    has_recipe: p.has_recipe,
  }));
  if (list.length === 0)
    return (
      <EmptyState
        title="No hay productos con control de stock"
        body="Activa productos en el catálogo para producirlos aquí."
      />
    );
  return (
    <ProductionBoard
      products={list}
      flagDefault={flag.rows[0]?.enabled ?? false}
      canWrite={canWrite}
      threshold={Number(settings.rows[0]?.low_stock_threshold ?? 5)}
    />
  );
}

async function BatchesTab({ fecha, producto }: { fecha: string; producto?: string }) {
  const d = db();
  const [batches, products] = await Promise.all([
    sql<{
      id: string;
      lot_code: string;
      product_name: string;
      qty: string;
      produced_at: Date;
      staff_name: string | null;
      notes: string | null;
      ingredients_consumed: boolean;
      undone_at: Date | null;
    }>`select b.id, b.lot_code, p.name as product_name, b.qty::text, b.produced_at, s.full_name as staff_name, b.notes, b.ingredients_consumed, b.undone_at
       from production_batches b
       join products p on p.id = b.product_id
       left join staff_users s on s.id = b.staff_id
       where (b.produced_at at time zone (select timezone from business_settings where id = 1))::date = ${fecha}::date
         and (${producto ?? null}::uuid is null or b.product_id = ${producto ?? null}::uuid)
       order by b.produced_at desc`.execute(d),
    sql<{
      id: string;
      name: string;
    }>`select id, name from products where deleted_at is null and is_active order by name`.execute(
      d,
    ),
  ]);
  const total = batches.rows.filter((b) => !b.undone_at).reduce((a, b) => a + Number(b.qty), 0);
  return (
    <>
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-4" method="get">
        <input type="hidden" name="tab" value="lotes" />
        <div>
          <label className="label" htmlFor="fecha">
            Fecha
          </label>
          <input
            id="fecha"
            name="fecha"
            type="date"
            className="input min-h-11"
            defaultValue={fecha}
          />
        </div>
        <div className="min-w-56">
          <label className="label" htmlFor="producto">
            Producto
          </label>
          <select
            id="producto"
            name="producto"
            className="input min-h-11"
            defaultValue={producto ?? ""}
          >
            <option value="">Todos</option>
            {products.rows.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary min-h-11">Filtrar</button>
        <span className="ml-auto text-sm text-muted">
          {batches.rows.length} lotes · {qty(total)} piezas
        </span>
      </form>
      {batches.rows.length === 0 ? (
        <EmptyState
          title="Sin lotes en esta fecha"
          body="Los lotes registrados en Producción del día aparecen aquí."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>Lote</th>
              <th>Producto</th>
              <th className="text-right">Cantidad</th>
              <th>Responsable</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {batches.rows.map((b) => (
              <tr key={b.id} className={b.undone_at ? "opacity-60" : ""}>
                <td className="tabular-nums">{fmtDate(b.produced_at, "time")}</td>
                <td className="font-mono text-xs">{b.lot_code}</td>
                <td>{b.product_name}</td>
                <td className="text-right tabular-nums">{qty(b.qty)}</td>
                <td>{b.staff_name ?? "—"}</td>
                <td className="text-muted">
                  {b.undone_at && (
                    <Badge tone="gray" className="mr-1">
                      Deshecho
                    </Badge>
                  )}
                  {b.ingredients_consumed && (
                    <Badge tone="blue" className="mr-1">
                      Insumos
                    </Badge>
                  )}
                  {b.notes}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

async function PlanTab({ fecha }: { fecha: string }) {
  const d = db();
  const [plan, committed] = await Promise.all([
    sql<{
      product_id: string;
      product_name: string;
      committed_qty: string;
      avg_sold_qty: string;
      on_hand: string;
      suggested_qty: string;
    }>`select product_id, product_name, committed_qty::text, avg_sold_qty::text, on_hand::text, suggested_qty::text
       from suggested_production(${fecha}::date)`.execute(d),
    sql<{
      product_id: string;
      product_name: string;
      order_id: string;
      folio: string;
      customer_name: string | null;
      status: OrderStatus;
      scheduled_for: Date | null;
      qty: string;
    }>`select oi.product_id, oi.product_name, o.id as order_id, o.folio, o.customer_name, o.status, o.scheduled_for, sum(oi.qty)::text as qty
       from orders o join order_items oi on oi.order_id = o.id
       where (o.scheduled_for at time zone (select timezone from business_settings where id = 1))::date = ${fecha}::date
         and o.status not in ('cancelled', 'refunded', 'completed', 'delivered')
       group by oi.product_id, oi.product_name, o.id, o.folio, o.customer_name, o.status, o.scheduled_for
       order by oi.product_name, o.scheduled_for, o.folio`.execute(d),
  ]);
  const relevant = plan.rows.filter(
    (r) => Number(r.suggested_qty) > 0 || Number(r.committed_qty) > 0 || Number(r.avg_sold_qty) > 0,
  );
  const byProduct = new Map<string, typeof committed.rows>();
  for (const c of committed.rows) {
    const list = byProduct.get(c.product_id) ?? [];
    list.push(c);
    byProduct.set(c.product_id, list);
  }
  const dateLabel = fmtDate(`${fecha}T12:00:00`, "long");
  return (
    <>
      <form className="card no-print mb-4 flex flex-wrap items-end gap-3 p-4" method="get">
        <input type="hidden" name="tab" value="plan" />
        <div>
          <label className="label" htmlFor="fecha">
            Fecha a planear
          </label>
          <input
            id="fecha"
            name="fecha"
            type="date"
            className="input min-h-11"
            defaultValue={fecha}
          />
        </div>
        <button className="btn btn-secondary min-h-11">Ver plan</button>
        <div className="ml-auto">
          <PrintButton label="Imprimir plan" />
        </div>
      </form>
      <Card title={`Plan de producción · ${dateLabel}`}>
        <p className="mb-3 text-sm text-muted">
          Sugerido = pedidos comprometidos + promedio de ventas de los últimos 4 mismos días de la
          semana − stock actual.
        </p>
        {relevant.length === 0 ? (
          <p className="text-sm text-muted">
            Sin pedidos comprometidos ni historial de ventas para esta fecha.
          </p>
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-right">Comprometido</th>
                <th className="text-right">Prom. vendido</th>
                <th className="text-right">Stock</th>
                <th className="text-right">Sugerido</th>
              </tr>
            </thead>
            <tbody>
              {relevant.map((r) => (
                <tr key={r.product_id}>
                  <td>{r.product_name}</td>
                  <td className="text-right tabular-nums">{qty(r.committed_qty)}</td>
                  <td className="text-right tabular-nums">{qty(r.avg_sold_qty)}</td>
                  <td className="text-right tabular-nums">{qty(r.on_hand)}</td>
                  <td className="text-right font-semibold tabular-nums">{qty(r.suggested_qty)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <div className="mt-4">
        <Card title="Pedidos comprometidos por producto y cliente">
          {byProduct.size === 0 ? (
            <p className="text-sm text-muted">No hay pedidos programados para esta fecha.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {[...byProduct.entries()].map(([pid, rows]) => (
                <div key={pid} className="rounded-[var(--r-card)] border border-line p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold">{rows[0]!.product_name}</h3>
                    <span className="tabular-nums text-sm">
                      {qty(rows.reduce((a, r) => a + Number(r.qty), 0))} pzas
                    </span>
                  </div>
                  <ul className="divide-y divide-line text-sm">
                    {rows.map((r) => (
                      <li
                        key={r.order_id}
                        className="flex items-center justify-between gap-2 py-1.5"
                      >
                        <span>
                          <Link
                            href={`/pedidos/${r.order_id}`}
                            className="font-mono text-xs underline"
                          >
                            {r.folio}
                          </Link>{" "}
                          {r.customer_name ?? "Sin nombre"}
                          {r.scheduled_for && (
                            <span className="text-muted">
                              {" "}
                              · {fmtDate(r.scheduled_for, "time")}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge tone={ORDER_STATUS_TONE[r.status]}>
                            {ORDER_STATUS_LABELS[r.status]}
                          </Badge>
                          <span className="tabular-nums">{qty(r.qty)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * Especiales: productos temporales (navideños, de temporada, ediciones limitadas).
 * Son productos normales marcados con `is_temporary` (migración 0017): el precio vive en
 * `product_prices` y el stock en `inventory_movements`, igual que cualquier otro producto.
 */
async function SpecialsTab({ canWrite, canStock }: { canWrite: boolean; canStock: boolean }) {
  const res = await sql<{
    id: string;
    name: string;
    slug: string;
    is_active: boolean;
    track_stock: boolean;
    pos_price_cents: number | null;
    web_price_cents: number | null;
    on_hand: string | null;
    season_start: string | null;
    season_end: string | null;
  }>`select p.id, p.name, p.slug, p.is_active, p.track_stock,
            current_price_cents(p.id, 'pos') as pos_price_cents,
            current_price_cents(p.id, 'web') as web_price_cents,
            coalesce(l.on_hand, 0)::text as on_hand,
            to_char(p.season_start, 'YYYY-MM-DD') as season_start,
            to_char(p.season_end, 'YYYY-MM-DD') as season_end
     from products p
     left join inventory_levels l on l.product_id = p.id
     where p.is_temporary and p.deleted_at is null
     order by p.is_active desc, p.name`.execute(db());
  const rows: SpecialRow[] = res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    is_active: r.is_active,
    track_stock: r.track_stock,
    pos_price_cents: r.pos_price_cents,
    web_price_cents: r.web_price_cents,
    on_hand: Number(r.on_hand ?? 0),
    season_start: r.season_start,
    season_end: r.season_end,
  }));
  const activos = rows.filter((r) => r.is_active).length;

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div id="nuevo-especial" className="scroll-mt-4">
          <Card title="+ Producto especial">
            <p className="mb-3 text-sm text-muted">
              Para lo navideño, de temporada o de edición limitada. Se vende, se produce y se
              inventaría igual que cualquier producto; al terminar la temporada se desactiva (nunca
              se borra) y la siguiente se vuelve a activar con su historial.
            </p>
            <SpecialProductForm
              action={createSpecialProduct}
              reactivate={reactivateProduct}
              canStock={canStock}
            />
          </Card>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay productos especiales"
          body={
            canWrite
              ? "Crea el primero arriba: nombre, precio y stock. Podrás editarlo y desactivarlo cuando pase la temporada."
              : "Cuando administración cree uno, aparecerá aquí."
          }
        />
      ) : (
        <>
          <p className="px-1 text-sm text-muted">
            {activos} activo{activos === 1 ? "" : "s"} de {rows.length} · clic en una celda para
            editar nombre, precio o stock.
          </p>
          <SpecialProductList
            rows={rows}
            canWrite={canWrite}
            canStock={canStock}
            setName={setSpecialName}
            setPrice={setProductPrice}
            setFlag={setProductFlag}
            setStock={setSpecialStock}
          />
        </>
      )}
    </div>
  );
}
