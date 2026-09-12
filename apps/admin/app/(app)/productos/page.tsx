import Link from "next/link";
import { marginBps } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { qty, pct } from "@/lib/format";
import { PageHeader, Table, Badge, Money, EmptyState, LinkButton, Alert } from "@/components/ui";
import { Select, TextInput } from "@/components/catalog/fields";

export const metadata = { title: "Productos" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  variant_label: string | null;
  category_id: string | null;
  category_name: string | null;
  is_active: boolean;
  show_on_web: boolean;
  show_on_pos: boolean;
  track_stock: boolean;
  requires_preorder: boolean;
  is_featured: boolean;
  pos_price: number | null;
  web_price: number | null;
  cost: number | null;
  on_hand: string | number | null;
  image_url: string | null;
};

type Search = { q?: string; categoria?: string; estado?: string; canal?: string; eliminado?: string };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireSession("catalog.read");
  const canWrite = hasPermission(session, "catalog.write");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const categoria = sp.categoria ?? "";
  const estado = sp.estado ?? "todos";
  const canal = sp.canal ?? "";

  const [categories, res] = await Promise.all([
    db().selectFrom("categories").select(["id", "name"]).where("deleted_at", "is", null).orderBy("sort_order").orderBy("name").execute(),
    sql<Row>`
      select p.id, p.name, p.slug, p.parent_id, p.variant_label, p.category_id, c.name as category_name,
             p.is_active, p.show_on_web, p.show_on_pos, p.track_stock, p.requires_preorder, p.is_featured,
             current_price_cents(p.id, 'pos') as pos_price,
             current_price_cents(p.id, 'web') as web_price,
             product_cost_cents(p.id) as cost,
             l.on_hand,
             (select url from product_images i where i.product_id = p.id order by is_primary desc, sort_order asc limit 1) as image_url
      from products p
      left join categories c on c.id = p.category_id
      left join inventory_levels l on l.product_id = p.id
      where p.deleted_at is null
        and (${q} = '' or p.name ilike ${"%" + q + "%"} or p.slug ilike ${"%" + q + "%"} or coalesce(p.sku,'') ilike ${"%" + q + "%"})
        and (${categoria} = '' or p.category_id = ${categoria || null}::uuid)
        and (${estado} = 'todos' or (${estado} = 'activos' and p.is_active) or (${estado} = 'inactivos' and not p.is_active))
        and (${canal} = '' or (${canal} = 'web' and p.show_on_web) or (${canal} = 'pos' and p.show_on_pos))
      order by c.sort_order nulls last, p.sort_order, p.name`.execute(db()),
  ]);

  const rows = res.rows;
  const byParent = new Map<string, Row[]>();
  for (const r of rows) if (r.parent_id) byParent.set(r.parent_id, [...(byParent.get(r.parent_id) ?? []), r]);
  const parentIds = new Set(rows.filter((r) => !r.parent_id).map((r) => r.id));
  const ordered: Array<{ row: Row; depth: number }> = [];
  for (const r of rows) {
    if (r.parent_id && parentIds.has(r.parent_id)) continue; // se pinta bajo su padre
    ordered.push({ row: r, depth: 0 });
    for (const v of byParent.get(r.id) ?? []) ordered.push({ row: v, depth: 1 });
  }

  return (
    <>
      <PageHeader
        title="Productos"
        subtitle={`${rows.filter((r) => !r.parent_id).length} productos · ${rows.filter((r) => r.parent_id).length} variantes`}
        actions={canWrite ? <LinkButton href="/productos/nuevo">Nuevo producto</LinkButton> : undefined}
      />
      {sp.eliminado && (
        <div className="mb-4">
          <Alert tone="green">Producto eliminado.</Alert>
        </div>
      )}
      <form method="get" className="card mb-4 grid grid-cols-2 gap-3 p-3 md:grid-cols-[1fr_180px_150px_150px_auto] md:items-end">
        <TextInput label="Buscar" name="q" defaultValue={q} placeholder="Nombre, slug o SKU" className="col-span-2 md:col-span-1" />
        <Select label="Categoría" name="categoria" defaultValue={categoria}>
          <option value="">Todas</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="Estado" name="estado" defaultValue={estado}>
          <option value="todos">Todos</option>
          <option value="activos">Activos</option>
          <option value="inactivos">Inactivos</option>
        </Select>
        <Select label="Canal" name="canal" defaultValue={canal}>
          <option value="">Todos</option>
          <option value="web">Tienda web</option>
          <option value="pos">POS</option>
        </Select>
        <div className="col-span-2 flex gap-2 md:col-span-1">
          <button className="btn btn-secondary" type="submit">
            Filtrar
          </button>
          {(q || categoria || estado !== "todos" || canal) && (
            <Link href="/productos" className="btn btn-secondary">
              Limpiar
            </Link>
          )}
        </div>
      </form>

      {ordered.length === 0 ? (
        <EmptyState
          title="Sin productos"
          body={q || categoria ? "Ningún producto coincide con los filtros." : "Crea tu primer producto para empezar a vender."}
          action={canWrite ? <LinkButton href="/productos/nuevo">Nuevo producto</LinkButton> : undefined}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Categoría</th>
              <th className="text-right">Precio POS</th>
              <th className="text-right">Precio web</th>
              <th className="text-right">Costo</th>
              <th className="text-right">Margen</th>
              <th className="text-right">Stock</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map(({ row: p, depth }) => {
              const margin = p.pos_price !== null && p.cost !== null ? marginBps(p.pos_price, p.cost) : null;
              return (
                <tr key={p.id} className={depth ? "bg-black/[0.015]" : ""}>
                  <td>
                    <div className={`flex items-center gap-3 ${depth ? "pl-6" : ""}`}>
                      {p.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image_url} alt="" className="size-10 shrink-0 rounded-lg object-cover" loading="lazy" />
                      ) : (
                        <div className="size-10 shrink-0 rounded-lg bg-black/5" aria-hidden />
                      )}
                      <div className="min-w-0">
                        <Link href={`/productos/${p.id}`} className="font-medium hover:underline">
                          {depth ? (
                            <>
                              <span className="text-muted">↳ </span>
                              {p.variant_label}
                            </>
                          ) : (
                            p.name
                          )}
                        </Link>
                        <div className="truncate text-xs text-muted">
                          {depth ? p.name : `/${p.slug}`}
                          {p.is_featured && " · destacado"}
                          {p.requires_preorder && " · bajo pedido"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-muted">{p.category_name ?? "—"}</td>
                  <td className="text-right">
                    <Money cents={p.pos_price} />
                  </td>
                  <td className="text-right">
                    <Money cents={p.web_price} />
                  </td>
                  <td className="text-right">
                    {p.cost === null ? (
                      <Link href={`/recetas/${p.id}`} className="text-xs text-teal-d hover:underline">
                        sin receta
                      </Link>
                    ) : (
                      <Money cents={p.cost} />
                    )}
                  </td>
                  <td className={`text-right tabular-nums ${margin !== null && margin < 3000 ? "text-red-d" : ""}`}>
                    {margin === null ? "—" : pct(margin)}
                  </td>
                  <td className="text-right tabular-nums">{p.track_stock ? qty(p.on_hand ?? 0) : <span className="text-muted">n/a</span>}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={p.is_active ? "green" : "gray"}>{p.is_active ? "Activo" : "Inactivo"}</Badge>
                      {p.show_on_web && <Badge tone="blue">Web</Badge>}
                      {p.show_on_pos && <Badge tone="gray">POS</Badge>}
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
