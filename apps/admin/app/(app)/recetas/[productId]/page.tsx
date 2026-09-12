import Link from "next/link";
import { notFound } from "next/navigation";
import type { BaseUnit } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Card, Badge, LinkButton } from "@/components/ui";
import { RecipeEditor, type RecipeIngredient, type RecipeInitial } from "@/components/catalog/recipe-editor";
import { ConfirmButton } from "@/components/catalog/action-form";
import { deleteRecipe, saveRecipe } from "../actions";

export const dynamic = "force-dynamic";

export default async function RecipePage({ params }: { params: Promise<{ productId: string }> }) {
  const session = await requireSession("recipes.read");
  const canWrite = hasPermission(session, "recipes.write");
  const { productId } = await params;
  const product = await db()
    .selectFrom("products")
    .select(["id", "name", "variant_label", "parent_id", "is_active"])
    .where("id", "=", productId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!product) notFound();

  const [ingredientsRes, recipe, priceRes] = await Promise.all([
    sql<RecipeIngredient>`
      select i.id, i.name || coalesce(' (' || i.brand || ')', '') as name, i.base_unit, ingredient_unit_cost(i.id)::float8 as unit_cost, i.is_available
      from ingredients i where i.deleted_at is null order by i.name`.execute(db()),
    db().selectFrom("recipes").selectAll().where("product_id", "=", productId).executeTakeFirst(),
    sql<{ cost: number | null; pos: number | null }>`select product_cost_cents(${productId}) as cost, current_price_cents(${productId}, 'pos') as pos`.execute(db()),
  ]);
  const items = recipe
    ? await db().selectFrom("recipe_items").select(["ingredient_id", "qty", "note"]).where("recipe_id", "=", recipe.id).orderBy("sort_order").execute()
    : [];
  const initial: RecipeInitial | null = recipe
    ? {
        yield_qty: Number(recipe.yield_qty),
        yield_label: recipe.yield_label,
        labor_cents: recipe.labor_cents,
        overhead_cents: recipe.overhead_cents,
        notes: recipe.notes,
        items: items.map((it) => ({ ingredient_id: it.ingredient_id, qty: Number(it.qty), note: it.note })),
      }
    : null;
  const st = priceRes.rows[0]!;
  const ingredients = ingredientsRes.rows.map((i) => ({ ...i, base_unit: i.base_unit as BaseUnit }));

  return (
    <>
      <PageHeader
        title={`Receta · ${product.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/recetas" className="hover:underline">
              ← Recetas
            </Link>
            {recipe ? <Badge tone="green">v{recipe.version} · {fmtDate(recipe.updated_at, "datetime")}</Badge> : <Badge tone="amber">Sin receta</Badge>}
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
          sqlCostCents={st.cost}
          posPriceCents={st.pos}
          canWrite={canWrite}
        />
      </Card>
      {canWrite && recipe && (
        <Card title="Zona de riesgo" className="mt-4">
          <form action={deleteRecipe.bind(null, product.id)} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">Borrar la receta deja al producto sin costo (las ventas pasadas conservan su costo snapshot).</span>
            <ConfirmButton variant="danger" confirm={`¿Eliminar la receta de "${product.name}"?`}>
              Eliminar receta
            </ConfirmButton>
          </form>
        </Card>
      )}
    </>
  );
}
