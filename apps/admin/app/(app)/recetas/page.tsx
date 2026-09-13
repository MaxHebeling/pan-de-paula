import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { pct, qty } from "@/lib/format";
import { PageHeader, Table, Badge, Money, Card, Stat } from "@/components/ui";
import { LinkTabs } from "@/components/catalog/tabs";
import { FormulaDetails } from "@/components/catalog/formula";
import { formulaLines } from "@/components/catalog/formula-lines";
import { marginTone, normalizeBreakdown } from "@/components/catalog/costing-types";

export const metadata = { title: "Recetas y costos" };
export const dynamic = "force-dynamic";

type Row = {
  product_id: string;
  product_name: string;
  category_name: string | null;
  yield_qty: string;
  ingredients_cost: string;
  labor_cents: number;
  overhead_cents: number;
  cost_per_piece_cents: number | null;
  pos_price_cents: number | null;
  margin_bps: number | null;
  ingredient_count: number;
  has_missing_prices: boolean;
  updated_at: Date;
  suggested_price_cents: number | null;
  target_margin_bps: number;
  breakdown: unknown;
};

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSession("recipes.read");
  const { q = "" } = await searchParams;
  const like = `%${q.trim()}%`;
  const [withRecipe, without] = await Promise.all([
    sql<Row>`
      select rc.product_id, rc.product_name, c.name as category_name, rc.yield_qty, rc.ingredients_cost, rc.labor_cents, rc.overhead_cents,
             rc.cost_per_piece_cents, rc.pos_price_cents, rc.margin_bps, rc.ingredient_count::int as ingredient_count, rc.has_missing_prices, r.updated_at,
             rc.suggested_price_cents, rc.target_margin_bps, recipe_formula_breakdown(rc.product_id) as breakdown
      from recipe_costing rc
      join recipes r on r.id = rc.recipe_id
      join products p on p.id = rc.product_id and p.deleted_at is null
      left join categories c on c.id = p.category_id
      where (${q.trim()} = '' or rc.product_name ilike ${like})
      order by rc.product_name`.execute(db()),
    sql<{
      id: string;
      name: string;
      category_name: string | null;
      pos_price_cents: number | null;
      is_active: boolean;
    }>`
      select p.id, p.name, c.name as category_name, current_price_cents(p.id, 'pos') as pos_price_cents, p.is_active
      from products p left join categories c on c.id = p.category_id
      where p.deleted_at is null and not exists (select 1 from recipes r where r.product_id = p.id)
        and (${q.trim()} = '' or p.name ilike ${like})
      order by p.is_active desc, p.name`.execute(db()),
  ]);
  const rows = withRecipe.rows;
  const lowMargin = rows.filter(
    (r) => r.margin_bps !== null && r.margin_bps < r.target_margin_bps,
  ).length;
  const missing = rows.filter((r) => r.has_missing_prices).length;
  const avgMargin = rows.filter((r) => r.margin_bps !== null);
  const avg = avgMargin.length
    ? Math.round(avgMargin.reduce((a, r) => a + (r.margin_bps ?? 0), 0) / avgMargin.length)
    : null;

  return (
    <>
      <PageHeader
        title="Recetas y costos"
        subtitle="Costo por pieza calculado desde los precios vigentes de los insumos. Abre ▸ Fórmula en cada fila para ver el cálculo con sus números."
      />
      <LinkTabs
        items={[
          { href: "/recetas", label: "Recetas", active: true },
          { href: "/recetas/hoja", label: "Hoja de costos", active: false },
        ]}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Con receta" value={rows.length} hint={`${without.rows.length} sin receta`} />
        <Stat
          label="Margen promedio"
          value={avg === null ? "—" : pct(avg)}
          hint="sobre precio POS"
        />
        <Stat
          label="Bajo el margen objetivo"
          value={lowMargin}
          tone={lowMargin ? "amber" : undefined}
          hint={lowMargin ? "revisar precio o receta" : "todo en orden"}
        />
        <Stat
          label="Con insumos sin precio"
          value={missing}
          tone={missing ? "amber" : undefined}
          hint={missing ? "el costo real es mayor" : "costos completos"}
        />
      </div>
      <form method="get" className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-60 flex-1">
          <label htmlFor="q" className="label">
            Buscar producto
          </label>
          <input id="q" name="q" className="input" defaultValue={q} placeholder="Croissant…" />
        </div>
        <button className="btn btn-secondary" type="submit">
          Buscar
        </button>
        {q && (
          <Link href="/recetas" className="btn btn-secondary">
            Limpiar
          </Link>
        )}
      </form>
      <Table>
        <thead>
          <tr>
            <th>Producto</th>
            <th className="text-right">Ingr.</th>
            <th className="text-right">Rinde</th>
            <th className="text-right">Insumos / lote</th>
            <th className="text-right">MO + ind.</th>
            <th className="text-right">Costo / pieza</th>
            <th className="text-right">Precio POS</th>
            <th className="text-right">Margen</th>
            <th className="text-right">Sugerido</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="py-8 text-center text-muted">
                Ninguna receta{q ? " coincide con la búsqueda" : " registrada todavía"}.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const b = normalizeBreakdown(r.breakdown);
            const tone = marginTone(r.margin_bps, r.target_margin_bps);
            return (
              <tr key={r.product_id}>
                <td>
                  <Link href={`/recetas/${r.product_id}`} className="font-medium hover:underline">
                    {r.product_name}
                  </Link>
                  <div className="text-xs text-muted">{r.category_name ?? ""}</div>
                  <FormulaDetails
                    summary="Fórmula"
                    lines={formulaLines(b, { includeLines: true, channel: "pos" })}
                  />
                </td>
                <td className="text-right tabular-nums">{r.ingredient_count}</td>
                <td className="text-right tabular-nums">{qty(r.yield_qty)}</td>
                <td className="text-right tabular-nums">
                  ${Number(r.ingredients_cost).toFixed(2)}
                </td>
                <td className="text-right">
                  <Money cents={r.labor_cents + r.overhead_cents} />
                </td>
                <td className="text-right font-medium">
                  <Money cents={r.cost_per_piece_cents} />
                  {r.has_missing_prices && (
                    <Badge tone="amber" className="ml-1">
                      incompleto
                    </Badge>
                  )}
                </td>
                <td className="text-right">
                  <Money cents={r.pos_price_cents} />
                </td>
                <td
                  className={`text-right tabular-nums ${tone === "red" ? "font-semibold text-red-d" : tone === "amber" ? "font-semibold text-amber-d" : ""}`}
                  title={`objetivo ${pct(r.target_margin_bps)}`}
                >
                  {pct(r.margin_bps)}
                </td>
                <td className="text-right text-muted">
                  <Money cents={r.suggested_price_cents} />
                </td>
                <td className="text-right">
                  <Link href={`/recetas/${r.product_id}`} className="btn btn-secondary btn-sm">
                    Editar
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <Card title={`Productos sin receta (${without.rows.length})`} className="mt-4">
        {without.rows.length === 0 ? (
          <p className="text-sm text-muted">Todos los productos tienen receta.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {without.rows.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-black/[0.03]"
              >
                <span>
                  {p.name}
                  {!p.is_active && <span className="ml-1 text-xs text-muted">(inactivo)</span>}
                  <span className="ml-1 text-xs text-muted">{p.category_name ?? ""}</span>
                </span>
                <Link
                  href={`/recetas/${p.id}`}
                  className="whitespace-nowrap text-xs text-teal-d hover:underline"
                >
                  Crear receta →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
