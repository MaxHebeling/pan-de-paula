import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { loadCostingSettings } from "@/lib/costing";
import { PageHeader, LinkButton } from "@/components/ui";
import { LinkTabs } from "@/components/catalog/tabs";
import { CostSheet, type SheetRow } from "@/components/catalog/cost-sheet";
import { normalizeBreakdown } from "@/components/catalog/costing-types";
import { fmtPct } from "@/components/catalog/formula-lines";
import { applySuggestedPrice, setSheetPrice, updateRecipeParams } from "../actions";

export const metadata = { title: "Hoja de costos" };
export const dynamic = "force-dynamic";

export default async function CostSheetPage() {
  const session = await requireSession("recipes.read");
  const canEditRecipe = hasPermission(session, "recipes.write");
  const canEditPrice = hasPermission(session, "catalog.write");
  const [{ breakdownSettings }, rowsRes, categories] = await Promise.all([
    loadCostingSettings(),
    sql<{
      product_id: string;
      name: string;
      category_id: string | null;
      category_name: string | null;
      breakdown: unknown;
    }>`
      select p.id as product_id,
             case when pp.id is not null then pp.name || ' · ' || coalesce(p.variant_label, p.name) else p.name end as name,
             p.category_id, c.name as category_name,
             recipe_formula_breakdown(p.id) as breakdown
      from products p
      left join products pp on pp.id = p.parent_id
      left join categories c on c.id = p.category_id
      where p.deleted_at is null and p.is_active
      order by c.sort_order nulls last, coalesce(pp.sort_order, p.sort_order), coalesce(pp.name, p.name), p.parent_id nulls first, p.name`.execute(
      db(),
    ),
    db()
      .selectFrom("categories")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .orderBy("sort_order")
      .orderBy("name")
      .execute(),
  ]);
  const rows: SheetRow[] = rowsRes.rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    category_id: r.category_id,
    category_name: r.category_name,
    breakdown: normalizeBreakdown(r.breakdown),
  }));
  const s = breakdownSettings;

  return (
    <>
      <PageHeader
        title="Hoja de costos"
        subtitle={`Todos los productos activos, editables celda por celda. Margen objetivo ${fmtPct(s.default_target_margin_bps, 0)} · redondeo a múltiplos de $${(s.price_rounding_cents / 100).toFixed(2)} · merma default ${fmtPct(s.default_waste_bps, 2)} · MO ${s.labor_mode === "per_hour" ? `por hora ($${(s.labor_rate_cents_per_hour / 100).toFixed(2)}/h)` : "por lote"} · indirectos ${s.overhead_mode === "pct_of_ingredients" ? `${fmtPct(s.overhead_pct_bps, 2)} de insumos` : "fijos por lote"}.`}
        actions={
          hasPermission(session, "settings.write") ? (
            <LinkButton href="/configuracion?tab=formulas" variant="secondary">
              Parámetros de fórmulas
            </LinkButton>
          ) : undefined
        }
      />
      <LinkTabs
        items={[
          { href: "/recetas", label: "Recetas", active: false },
          { href: "/recetas/hoja", label: "Hoja de costos", active: true },
        ]}
      />
      <CostSheet
        rows={rows}
        categories={categories}
        settings={s}
        canEditRecipe={canEditRecipe}
        canEditPrice={canEditPrice}
        actions={{
          updateParams: updateRecipeParams,
          setPrice: setSheetPrice,
          applySuggested: applySuggestedPrice,
        }}
      />
    </>
  );
}
