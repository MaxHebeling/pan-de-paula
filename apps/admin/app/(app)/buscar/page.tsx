import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Card, Badge, Money, EmptyState } from "@/components/ui";
import { fmtDate, qty } from "@/lib/format";
import { globalSearch, searchScope } from "@/lib/search";
import { CHANNEL_LABELS, ORDER_STATUS_LABELS } from "@/lib/customers";

export const metadata = { title: "Buscar" };
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const q = ((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? "").trim();
  const r =
    q.length >= 2
      ? await globalSearch(
          q,
          25,
          searchScope((perm) => hasPermission(session, perm)),
        )
      : null;
  const total = r ? r.customers.length + r.orders.length + r.products.length : 0;
  return (
    <>
      <PageHeader
        title="Buscar"
        subtitle={r ? `${total} resultado(s) para “${q}”` : "Clientes, pedidos y productos"}
      />
      <form className="card mb-4 flex flex-wrap items-end gap-2 p-3" action="/buscar" method="get">
        <div className="min-w-[240px] flex-1">
          <label className="label" htmlFor="q">
            Buscar
          </label>
          <input
            id="q"
            name="q"
            className="input"
            defaultValue={q}
            placeholder="Nombre, teléfono, código PDP, folio o producto"
            autoFocus
          />
        </div>
        <button className="btn btn-primary">Buscar</button>
      </form>
      {r && total === 0 && (
        <EmptyState
          title="Sin resultados"
          body="Revisa la ortografía o prueba con el teléfono o el código."
        />
      )}
      {r && total > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={`Clientes (${r.customers.length})`}>
            {r.customers.length === 0 ? (
              <p className="text-sm text-muted">Ninguno.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {r.customers.map((c) => (
                  <li key={c.id} className="py-2">
                    <Link href={`/clientes/${c.id}`} className="font-medium hover:underline">
                      {c.full_name}
                    </Link>
                    <div className="text-xs text-muted">
                      <span className="font-mono">{c.public_code}</span>
                      {c.phone && ` · ${c.phone}`} · {c.points_balance} pts
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Pedidos (${r.orders.length})`}>
            {r.orders.length === 0 ? (
              <p className="text-sm text-muted">Ninguno.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {r.orders.map((o) => (
                  <li key={o.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/pedidos?q=${encodeURIComponent(o.folio)}`}
                        className="font-mono font-medium hover:underline"
                      >
                        {o.folio}
                      </Link>
                      <Money cents={o.total_cents} />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span>{o.customer_name ?? "sin nombre"}</span>
                      {o.customer_phone && <span>· {o.customer_phone}</span>}
                      <Badge tone="blue">{CHANNEL_LABELS[o.channel] ?? o.channel}</Badge>
                      <Badge tone="gray">{ORDER_STATUS_LABELS[o.status] ?? o.status}</Badge>
                      <span>· {fmtDate(o.placed_at, "datetime")}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Productos (${r.products.length})`}>
            {r.products.length === 0 ? (
              <p className="text-sm text-muted">Ninguno.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {r.products.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                    <div>
                      <Link
                        href={`/productos?q=${encodeURIComponent(p.name)}`}
                        className="font-medium hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted">
                        {p.category_name ?? "—"}
                        {!p.is_active && " · inactivo"}
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted">
                      {p.price_cents !== null && <Money cents={p.price_cents} compact />}
                      {p.on_hand !== null && <div>stock {qty(p.on_hand)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
