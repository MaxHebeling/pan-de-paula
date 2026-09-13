import Link from "next/link";
import { formatQty, type BaseUnit } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Table, Badge, EmptyState, LinkButton, Alert } from "@/components/ui";
import { Select, TextInput } from "@/components/catalog/fields";
import { formatUnitCost } from "@/components/catalog/units";
import {
  IngredientMinStockCell,
  IngredientPriceCell,
  type IngredientUsage,
} from "@/components/catalog/ingredient-inline";
import { FormulaDetails } from "@/components/catalog/formula";
import { unitCostFormula } from "@/components/catalog/formula-lines";
import { loadCostingSettings } from "@/lib/costing";
import { recordIngredientPriceQuick, setIngredientMinStock } from "./actions";

export const metadata = { title: "Ingredientes" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  brand: string | null;
  supplier_name: string | null;
  base_unit: BaseUnit;
  is_available: boolean;
  stock_qty: string;
  min_stock_qty: string;
  unit_cost: string | null;
  last_price_cents: number | null;
  last_package_qty: string | null;
  last_package_label: string | null;
  last_valid_from: Date | null;
  recipes: number;
  usages: IngredientUsage[];
};

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filtro?: string; eliminado?: string }>;
}) {
  const session = await requireSession("recipes.read");
  const canWrite = hasPermission(session, "recipes.write");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const filtro = sp.filtro ?? "";
  const res = await sql<Row>`
    select i.id, i.name, i.brand, s.name as supplier_name, i.base_unit, i.is_available, i.stock_qty, i.min_stock_qty,
           ingredient_unit_cost(i.id) as unit_cost,
           lp.price_cents as last_price_cents, lp.package_qty as last_package_qty, lp.package_label as last_package_label, lp.valid_from as last_valid_from,
           (select count(*)::int from recipe_items ri where ri.ingredient_id = i.id) as recipes,
           coalesce((
             select json_agg(json_build_object(
               'product_id', r.product_id, 'product_name', p.name, 'yield_qty', r.yield_qty::float8,
               'labor_cents', r.labor_cents, 'overhead_cents', r.overhead_cents, 'labor_minutes', r.labor_minutes::float8,
               'waste_bps', r.waste_bps, 'qty_this', ri.qty::float8,
               'other_cost', (select coalesce(sum(o.qty * coalesce(ingredient_unit_cost(o.ingredient_id), 0)), 0)::float8
                              from recipe_items o where o.recipe_id = r.id and o.ingredient_id <> i.id),
               'current_cost_cents', product_cost_cents(r.product_id)) order by p.name)
             from recipe_items ri join recipes r on r.id = ri.recipe_id join products p on p.id = r.product_id and p.deleted_at is null
             where ri.ingredient_id = i.id), '[]'::json) as usages
    from ingredients i
    left join suppliers s on s.id = i.supplier_id
    left join lateral (select price_cents, package_qty, package_label, valid_from from ingredient_prices p where p.ingredient_id = i.id order by valid_from desc limit 1) lp on true
    where i.deleted_at is null
      and (${q} = '' or i.name ilike ${"%" + q + "%"} or coalesce(i.brand,'') ilike ${"%" + q + "%"} or coalesce(s.name,'') ilike ${"%" + q + "%"})
      and (${filtro} = '' or (${filtro} = 'alerta' and i.stock_qty <= i.min_stock_qty) or (${filtro} = 'sin-precio' and ingredient_unit_cost(i.id) is null) or (${filtro} = 'no-disponible' and not i.is_available))
    order by i.name`.execute(db());
  const { breakdownSettings } = await loadCostingSettings();
  const rows = res.rows;
  const alerts = rows.filter((r) => Number(r.stock_qty) <= Number(r.min_stock_qty)).length;
  const noPrice = rows.filter((r) => r.unit_cost === null).length;

  return (
    <>
      <PageHeader
        title="Ingredientes"
        subtitle={`${rows.length} insumos · ${alerts} en alerta de stock · ${noPrice} sin precio${canWrite ? " · clic en “Último precio” o “Mínimo” para editar en línea" : ""}`}
        actions={
          <>
            <LinkButton href="/ingredientes/proveedores" variant="secondary">
              Proveedores
            </LinkButton>
            {canWrite && <LinkButton href="/ingredientes/nuevo">Nuevo ingrediente</LinkButton>}
          </>
        }
      />
      {sp.eliminado && (
        <div className="mb-4">
          <Alert tone="green">Ingrediente eliminado.</Alert>
        </div>
      )}
      <form
        method="get"
        className="card mb-4 grid grid-cols-2 gap-3 p-3 md:grid-cols-[1fr_200px_auto] md:items-end"
      >
        <TextInput
          label="Buscar"
          name="q"
          defaultValue={q}
          placeholder="Nombre, marca o proveedor"
          className="col-span-2 md:col-span-1"
        />
        <Select label="Mostrar" name="filtro" defaultValue={filtro}>
          <option value="">Todos</option>
          <option value="alerta">En alerta de stock</option>
          <option value="sin-precio">Sin precio</option>
          <option value="no-disponible">No disponibles</option>
        </Select>
        <div className="flex gap-2">
          <button className="btn btn-secondary" type="submit">
            Filtrar
          </button>
          {(q || filtro) && (
            <Link href="/ingredientes" className="btn btn-secondary">
              Limpiar
            </Link>
          )}
        </div>
      </form>
      {rows.length === 0 ? (
        <EmptyState
          title="Sin ingredientes"
          body="Registra tus insumos con su precio de compra para costear las recetas."
          action={
            canWrite ? (
              <LinkButton href="/ingredientes/nuevo">Nuevo ingrediente</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Ingrediente</th>
              <th>Proveedor</th>
              <th>Unidad</th>
              <th className="text-right">Costo unitario</th>
              <th>Último precio</th>
              <th className="text-right">Stock</th>
              <th className="text-right">Mínimo</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const stock = Number(r.stock_qty);
              const min = Number(r.min_stock_qty);
              const low = stock <= min;
              return (
                <tr key={r.id}>
                  <td>
                    <Link href={`/ingredientes/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    <div className="text-xs text-muted">
                      {r.brand ?? ""}
                      {r.recipes
                        ? `${r.brand ? " · " : ""}en ${r.recipes} receta${r.recipes === 1 ? "" : "s"}`
                        : ""}
                    </div>
                  </td>
                  <td className="text-muted">{r.supplier_name ?? "—"}</td>
                  <td className="text-muted">{r.base_unit}</td>
                  <td className="text-right tabular-nums">
                    {r.unit_cost === null ? (
                      <Badge tone="amber">sin precio</Badge>
                    ) : (
                      <>
                        {formatUnitCost(Number(r.unit_cost))}
                        <span className="text-xs text-muted">/{r.base_unit}</span>
                        {r.last_price_cents !== null && r.last_package_qty !== null && (
                          <FormulaDetails
                            summary="Fórmula"
                            lines={[
                              unitCostFormula(
                                r.last_price_cents,
                                Number(r.last_package_qty),
                                r.base_unit,
                                Number(r.unit_cost),
                              ),
                            ]}
                          />
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <IngredientPriceCell
                      ingredientId={r.id}
                      name={r.name}
                      baseUnit={r.base_unit}
                      currentUnitCost={r.unit_cost === null ? null : Number(r.unit_cost)}
                      last={
                        r.last_price_cents === null
                          ? null
                          : {
                              price_cents: r.last_price_cents,
                              package_qty: Number(r.last_package_qty),
                              label: r.last_package_label,
                            }
                      }
                      usages={r.usages}
                      settings={breakdownSettings}
                      canWrite={canWrite}
                      action={recordIngredientPriceQuick}
                    />
                    {r.last_valid_from && (
                      <div className="px-2 text-xs text-muted">{fmtDate(r.last_valid_from)}</div>
                    )}
                  </td>
                  <td
                    className={`text-right tabular-nums ${low ? "font-semibold text-red-d" : ""}`}
                  >
                    {formatQty(stock, r.base_unit)}
                  </td>
                  <td>
                    <IngredientMinStockCell
                      ingredientId={r.id}
                      name={r.name}
                      baseUnit={r.base_unit}
                      value={min}
                      canWrite={canWrite}
                      action={setIngredientMinStock}
                    />
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {!r.is_available && <Badge tone="gray">No disponible</Badge>}
                      {low && (
                        <Badge tone={stock <= 0 ? "red" : "amber"}>
                          {stock <= 0 ? "Agotado" : "Bajo"}
                        </Badge>
                      )}
                      {r.is_available && !low && <Badge tone="green">OK</Badge>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
