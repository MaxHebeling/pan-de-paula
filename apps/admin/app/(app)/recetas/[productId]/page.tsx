import Link from "next/link";
import { notFound } from "next/navigation";
import type { BaseUnit } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { loadBreakdown, loadCostingSettings } from "@/lib/costing";
import { fmtDate } from "@/lib/format";
import { PageHeader, Card, Badge, LinkButton } from "@/components/ui";
import {
  RecipeEditor,
  type RecipeIngredient,
  type RecipeInitial,
} from "@/components/catalog/recipe-editor";
import { ConfirmButton } from "@/components/catalog/action-form";
import { recordIngredientPriceQuick } from "../../ingredientes/actions";
import { applySuggestedPrice, deleteRecipe, saveRecipe } from "../actions";

export const dynamic = "force-dynamic";

export default async function RecipePage({ params }: { params: Promise<{ productId: string }> }) {
  const session = await requireSession("recipes.read");
  const canWrite = hasPermission(session, "recipes.write");
  const canWritePrice = hasPermission(session, "catalog.write");
  const { productId } = await params;
  const product = await db()
    .selectFrom("products")
    .select(["id", "name", "variant_label", "parent_id", "is_active"])
    .where("id", "=", productId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!product) notFound();

  const [ingredientsRes, recipe, priceRes, breakdown, { breakdownSettings }] = await Promise.all([
    sql<RecipeIngredient>`
      select i.id, i.name || coalesce(' (' || i.brand || ')', '') as name, i.base_unit, ingredient_unit_cost(i.id)::float8 as unit_cost, i.is_available,
             lp.price_cents as last_price_cents, lp.package_qty::float8 as last_package_qty
      from ingredients i
      left join lateral (select price_cents, package_qty from ingredient_prices p where p.ingredient_id = i.id order by valid_from desc limit 1) lp on true
      where i.deleted_at is null order by i.name`.execute(db()),
    db().selectFrom("recipes").selectAll().where("product_id", "=", productId).executeTakeFirst(),
    sql<{
      pos: number | null;
      web: number | null;
    }>`select current_price_cents(${productId}, 'pos') as pos, current_price_cents(${productId}, 'web') as web`.execute(
      db(),
    ),
    loadBreakdown(productId),
    loadCostingSettings(),
  ]);
  const items = recipe
    ? await db()
        .selectFrom("recipe_items")
        .select(["ingredient_id", "qty", "note"])
        .where("recipe_id", "=", recipe.id)
        .orderBy("sort_order")
        .execute()
    : [];
  const initial: RecipeInitial | null = recipe
    ? {
        yield_qty: Number(recipe.yield_qty),
        yield_label: recipe.yield_label,
        labor_cents: recipe.labor_cents,
        overhead_cents: recipe.overhead_cents,
        notes: recipe.notes,
        waste_bps: recipe.waste_bps,
        target_margin_bps: recipe.target_margin_bps,
        labor_minutes: recipe.labor_minutes === null ? null : Number(recipe.labor_minutes),
        items: items.map((it) => ({
          ingredient_id: it.ingredient_id,
          qty: Number(it.qty),
          note: it.note,
        })),
      }
    : null;
  const st = priceRes.rows[0]!;
  const ingredients = ingredientsRes.rows.map((i) => ({
    ...i,
    base_unit: i.base_unit as BaseUnit,
  }));

  return (
    <>
      <PageHeader
        title={`Receta · ${product.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/recetas" className="hover:underline">
              ← Recetas
            </Link>
            <Link href="/recetas/hoja" className="hover:underline">
              · Hoja de costos
            </Link>
            {recipe ? (
              <Badge tone="green">
                v{recipe.version} · {fmtDate(recipe.updated_at, "datetime")}
              </Badge>
            ) : (
              <Badge tone="amber">Sin receta</Badge>
            )}
            {!product.is_active && <Badge tone="gray">Producto inactivo</Badge>}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/productos/${product.id}`} variant="secondary">
              Producto
            </LinkButton>
            <LinkButton href={`/precios/${product.id}`} variant="secondary">
              Precios
            </LinkButton>
          </>
        }
      />
      {ingredients.length === 0 && (
        <p className="st-amber mb-4 rounded-[var(--r-card)] px-4 py-3 text-sm">
          No hay ingredientes registrados.{" "}
          <Link href="/ingredientes/nuevo" className="underline">
            Crea el primero
          </Link>{" "}
          para poder armar la receta.
        </p>
      )}
      <Card>
        <RecipeEditor
          action={saveRecipe.bind(null, product.id)}
          ingredients={ingredients}
          initial={initial}
          breakdown={breakdown?.has_recipe ? breakdown : null}
          settings={breakdownSettings}
          productId={product.id}
          productName={product.name}
          posPriceCents={st.pos}
          webPriceCents={st.web}
          canWrite={canWrite}
          canWritePrice={canWritePrice}
          quickPriceAction={recordIngredientPriceQuick}
          applySuggestedAction={applySuggestedPrice}
        />
      </Card>
      {canWrite && recipe && (
        <Card title="Zona de riesgo" className="mt-4">
          <form
            action={deleteRecipe.bind(null, product.id)}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="text-muted">
              Borrar la receta deja al producto sin costo (las ventas pasadas conservan su costo
              snapshot).
            </span>
            <ConfirmButton variant="danger" confirm={`¿Eliminar la receta de "${product.name}"?`}>
              Eliminar receta
            </ConfirmButton>
          </form>
        </Card>
      )}
    </>
  );
}
