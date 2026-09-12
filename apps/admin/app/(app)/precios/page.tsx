import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { PageHeader, Table, Badge, Money, Stat } from "@/components/ui";
import { Select, TextInput } from "@/components/catalog/fields";

export const metadata = { title: "Precios y promociones" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  variant_label: string | null;
  parent_name: string | null;
  category_name: string | null;
  is_active: boolean;
  pos_price: number | null;
  web_price: number | null;
  cost: number | null;
  promo_label: string | null;
  promo_to: Date | null;
  promo_channel: string | null;
  upcoming: number;
};

export default async function PricesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filtro?: string }>;
}) {
  await requireSession("catalog.read");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const filtro = sp.filtro ?? "";
  const res = await sql<Row>`
    select p.id, p.name, p.variant_label, pp.name as parent_name, c.name as category_name, p.is_active,
           current_price_cents(p.id, 'pos') as pos_price, current_price_cents(p.id, 'web') as web_price, product_cost_cents(p.id) as cost,
           pr.label as promo_label, pr.valid_to as promo_to, pr.channel::text as promo_channel,
           (select count(*)::int from product_prices f where f.product_id = p.id and f.kind = 'promo' and f.valid_from > now()) as upcoming
    from products p
    left join products pp on pp.id = p.parent_id
    left join categories c on c.id = p.category_id
    left join lateral (
      select label, valid_to, channel from product_prices x
      where x.product_id = p.id and x.kind = 'promo' and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())
      order by valid_from desc limit 1
    ) pr on true
    where p.deleted_at is null
      and (${q} = '' or p.name ilike ${"%" + q + "%"})
      and (${filtro} = '' or (${filtro} = 'promo' and pr.label is not null) or (${filtro} = 'sin-precio' and current_price_cents(p.id, 'pos') is null)
           or (${filtro} = 'distinto' and current_price_cents(p.id, 'pos') is distinct from current_price_cents(p.id, 'web')))
    order by c.sort_order nulls last, coalesce(pp.sort_order, p.sort_order), coalesce(pp.name, p.name), p.parent_id nulls first, p.name`.execute(
    db(),
  );
  const rows = res.rows;
  const withPromo = rows.filter((r) => r.promo_label).length;
  const noPrice = rows.filter((r) => r.pos_price === null && r.web_price === null).length;

  return (
    <>
      <PageHeader
        title="Precios y promociones"
        subtitle="Precio vigente por canal. El historial nunca se edita: se cierran vigencias y se crean nuevas."
      />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Productos" value={rows.length} />
        <Stat
          label="Con promoción activa"
          value={withPromo}
          tone={withPromo ? "blue" : undefined}
        />
        <Stat
          label="Sin precio"
          value={noPrice}
          tone={noPrice ? "red" : undefined}
          hint={noPrice ? "no se pueden vender" : undefined}
        />
      </div>
      <form
        method="get"
        className="card mb-4 grid grid-cols-2 gap-3 p-3 md:grid-cols-[1fr_220px_auto] md:items-end"
      >
        <TextInput
          label="Buscar"
          name="q"
          defaultValue={q}
          placeholder="Producto"
          className="col-span-2 md:col-span-1"
        />
        <Select label="Mostrar" name="filtro" defaultValue={filtro}>
          <option value="">Todos</option>
          <option value="promo">Con promoción activa</option>
          <option value="distinto">Precio distinto web/POS</option>
          <option value="sin-precio">Sin precio</option>
        </Select>
        <div className="flex gap-2">
          <button className="btn btn-secondary" type="submit">
            Filtrar
          </button>
          {(q || filtro) && (
            <Link href="/precios" className="btn btn-secondary">
              Limpiar
            </Link>
          )}
        </div>
      </form>
      <Table>
        <thead>
          <tr>
            <th>Producto</th>
            <th className="text-right">POS</th>
            <th className="text-right">Web</th>
            <th className="text-right">Costo</th>
            <th>Promoción</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-8 text-center text-muted">
                Sin productos.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/precios/${r.id}`} className="font-medium hover:underline">
                  {r.parent_name ? `${r.parent_name} · ${r.variant_label}` : r.name}
                </Link>
                <div className="text-xs text-muted">
                  {r.category_name ?? ""}
                  {!r.is_active && " · inactivo"}
                </div>
              </td>
              <td className="text-right">
                <Money cents={r.pos_price} />
              </td>
              <td
                className={`text-right ${r.pos_price !== r.web_price ? "font-medium text-blue-d" : ""}`}
              >
                <Money cents={r.web_price} />
              </td>
              <td className="text-right text-muted">
                <Money cents={r.cost} />
              </td>
              <td>
                {r.promo_label ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badge tone="blue">{r.promo_label}</Badge>
                    <span className="text-xs text-muted">
                      {r.promo_channel === "all" ? "todos" : r.promo_channel} ·{" "}
                      {r.promo_to ? `hasta ${fmtDate(r.promo_to, "datetime")}` : "sin fin"}
                    </span>
                  </span>
                ) : r.upcoming ? (
                  <Badge tone="gray">
                    {r.upcoming} programada{r.upcoming === 1 ? "" : "s"}
                  </Badge>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="text-right">
                <Link href={`/precios/${r.id}`} className="btn btn-secondary btn-sm">
                  Gestionar
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
