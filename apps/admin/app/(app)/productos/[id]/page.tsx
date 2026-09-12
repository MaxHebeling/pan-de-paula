import Link from "next/link";
import { notFound } from "next/navigation";
import { marginBps } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { pct, qty } from "@/lib/format";
import { PageHeader, Card, Alert, Badge, LinkButton, Money, Stat, Table } from "@/components/ui";
import { ProductForm, type ProductFormValues } from "@/components/catalog/product-form";
import { ImageManager } from "@/components/catalog/image-manager";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/catalog/action-form";
import { FormGrid, MoneyInput, TextInput } from "@/components/catalog/fields";
import { createVariant, deleteProduct, setProductActive, updateProduct } from "../actions";

export const dynamic = "force-dynamic";

const toDate = (d: Date | string | null) =>
  d ? (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10)) : null;

export default async function ProductEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ creado?: string; aviso?: string }>;
}) {
  const session = await requireSession("catalog.read");
  const canWrite = hasPermission(session, "catalog.write");
  const { id } = await params;
  const sp = await searchParams;
  const p = await db().selectFrom("products").selectAll().where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  if (!p) notFound();

  const [categories, parents, images, variants, stats, hasSales] = await Promise.all([
    db().selectFrom("categories").select(["id", "name"]).where("deleted_at", "is", null).orderBy("sort_order").orderBy("name").execute(),
    db()
      .selectFrom("products")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .where("parent_id", "is", null)
      .where("id", "<>", id)
      .orderBy("name")
      .execute(),
    db().selectFrom("product_images").selectAll().where("product_id", "=", id).orderBy("sort_order").orderBy("created_at").execute(),
    sql<{ id: string; name: string; variant_label: string | null; is_active: boolean; pos_price: number | null; on_hand: string | null }>`
      select v.id, v.name, v.variant_label, v.is_active, current_price_cents(v.id, 'pos') as pos_price, l.on_hand
      from products v left join inventory_levels l on l.product_id = v.id
      where v.parent_id = ${id} and v.deleted_at is null order by v.sort_order, v.name`.execute(db()),
    sql<{ pos_price: number | null; web_price: number | null; cost: number | null; on_hand: string | null; has_recipe: boolean }>`
      select current_price_cents(${id}, 'pos') as pos_price, current_price_cents(${id}, 'web') as web_price,
             product_cost_cents(${id}) as cost, (select on_hand from inventory_levels where product_id = ${id}) as on_hand,
             exists(select 1 from recipes where product_id = ${id}) as has_recipe`.execute(db()),
    sql<{ h: boolean }>`select product_has_sales(${id}) as h`.execute(db()),
  ]);
  const st = stats.rows[0]!;
  const sold = hasSales.rows[0]?.h ?? false;
  const margin = st.pos_price !== null && st.cost !== null ? marginBps(st.pos_price, st.cost) : null;

  const initial: ProductFormValues = {
    name: p.name,
    slug: p.slug,
    sku: p.sku,
    short_description: p.short_description,
    description: p.description,
    category_id: p.category_id,
    parent_id: p.parent_id,
    variant_label: p.variant_label,
    unit_label: p.unit_label,
    highlighted_ingredients: p.highlighted_ingredients,
    allergens: p.allergens,
    tags: p.tags,
    is_active: p.is_active,
    is_featured: p.is_featured,
    show_on_web: p.show_on_web,
    show_on_pos: p.show_on_pos,
    track_stock: p.track_stock,
    allow_preorder: p.allow_preorder,
    requires_preorder: p.requires_preorder,
    pos_favorite: p.pos_favorite,
    preparation_hours: p.preparation_hours,
    season_start: toDate(p.season_start),
    season_end: toDate(p.season_end),
    sort_order: p.sort_order,
  };

  return (
    <>
      <PageHeader
        title={p.parent_id ? `${p.name}` : p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/productos" className="hover:underline">
              ← Productos
            </Link>
            <Badge tone={p.is_active ? "green" : "gray"}>{p.is_active ? "Activo" : "Inactivo"}</Badge>
            {p.parent_id && (
              <Link href={`/productos/${p.parent_id}`} className="text-xs hover:underline">
                Variante · ver producto principal
              </Link>
            )}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/recetas/${p.id}`} variant="secondary">
              Receta y costo
            </LinkButton>
            <LinkButton href={`/precios/${p.id}`} variant="secondary">
              Precios
            </LinkButton>
          </>
        }
      />
      {sp.creado && (
        <div className="mb-4">
          <Alert tone="green">Producto creado. Ahora puedes agregar imágenes, variantes y su receta.</Alert>
        </div>
      )}
      {sp.aviso === "ventas" && (
        <div className="mb-4">
          <Alert tone="amber">
            Este producto tiene ventas registradas, así que no se elimina: quedó <strong>desactivado</strong> para conservar el
            historial.
          </Alert>
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Precio POS" value={<Money cents={st.pos_price} />} hint={st.web_price !== st.pos_price ? <>web: <Money cents={st.web_price} /></> : "igual en web"} />
        <Stat
          label="Costo por pieza"
          value={st.cost === null ? "—" : <Money cents={st.cost} />}
          hint={st.has_recipe ? "según receta vigente" : <Link href={`/recetas/${p.id}`} className="text-teal-d hover:underline">sin receta</Link>}
        />
        <Stat label="Margen" value={margin === null ? "—" : pct(margin)} tone={margin !== null && margin < 3000 ? "red" : undefined} hint={margin !== null && margin < 3000 ? "por debajo de 30%" : undefined} />
        <Stat label="Stock" value={p.track_stock ? qty(st.on_hand ?? 0) : "n/a"} hint={p.track_stock ? "unidades" : "sin control de inventario"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-4">
          <Card title="Información">
            {canWrite ? (
              <ProductForm action={updateProduct.bind(null, p.id)} initial={initial} categories={categories} parents={parents} mode="edit" submitLabel="Guardar cambios" />
            ) : (
              <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                <div><dt className="text-muted">Slug</dt><dd>/{p.slug}</dd></div>
                <div><dt className="text-muted">Categoría</dt><dd>{categories.find((c) => c.id === p.category_id)?.name ?? "—"}</dd></div>
                <div className="md:col-span-2"><dt className="text-muted">Descripción</dt><dd>{p.description ?? "—"}</dd></div>
              </dl>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card title="Imágenes">
            <ImageManager productId={p.id} images={images} canWrite={canWrite} />
          </Card>
          {!p.parent_id && (
            <Card title="Variantes">
              {variants.rows.length === 0 ? (
                <p className="mb-3 text-sm text-muted">Sin variantes. Úsalas para tamaños, sabores o presentaciones.</p>
              ) : (
                <Table className="mb-3 !shadow-none">
                  <thead>
                    <tr>
                      <th>Variante</th>
                      <th className="text-right">Precio</th>
                      <th className="text-right">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {variants.rows.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <Link href={`/productos/${v.id}`} className="font-medium hover:underline">
                            {v.variant_label}
                          </Link>
                          {!v.is_active && <Badge tone="gray" className="ml-2">Inactiva</Badge>}
                        </td>
                        <td className="text-right"><Money cents={v.pos_price} /></td>
                        <td className="text-right tabular-nums">{qty(v.on_hand ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {canWrite && (
                <ActionForm action={createVariant.bind(null, p.id)} resetOnSuccess className="flex flex-col gap-3">
                  <FormGrid>
                    <TextInput label="Etiqueta" name="variant_label" required maxLength={40} placeholder="Chico, Nutella…" />
                    <MoneyInput label="Precio (MXN)" name="price" required />
                  </FormGrid>
                  <TextInput label="Nombre completo (opcional)" name="name" maxLength={120} hint={`Por defecto: "${p.name} + etiqueta"`} />
                  <SubmitButton variant="secondary" pendingText="Creando…">Agregar variante</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
          {canWrite && (
            <Card title="Zona de riesgo">
              <div className="flex flex-col gap-3 text-sm">
                <form action={setProductActive.bind(null, p.id, !p.is_active)} className="flex items-center justify-between gap-3">
                  <span className="text-muted">{p.is_active ? "Ocultar de tienda y POS sin borrar." : "Volver a ponerlo a la venta."}</span>
                  <ConfirmButton>{p.is_active ? "Desactivar" : "Activar"}</ConfirmButton>
                </form>
                <form action={deleteProduct.bind(null, p.id)} className="flex items-center justify-between gap-3">
                  <span className="text-muted">
                    {sold ? "Tiene ventas: al eliminar solo se desactiva (se conserva el historial)." : "Elimina el producto y sus variantes del catálogo."}
                  </span>
                  <ConfirmButton variant="danger" confirm={sold ? `"${p.name}" tiene ventas. Se desactivará en lugar de borrarse. ¿Continuar?` : `¿Eliminar "${p.name}"${variants.rows.length ? " y sus variantes" : ""}? Esta acción lo quita del catálogo.`}>
                    Eliminar
                  </ConfirmButton>
                </form>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
