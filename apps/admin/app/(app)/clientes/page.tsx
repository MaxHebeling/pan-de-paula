import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { PageHeader, Table, Badge, Money, LinkButton, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { listCustomers, customerCounts, loyaltyTiers, tierTone, type CustomerFilters } from "@/lib/customers";

export const metadata = { title: "Clientes" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const session = await requireSession("customers.read");
  const sp = await searchParams;
  const seg = one(sp.seg) as CustomerFilters["seg"];
  const filters: CustomerFilters = {
    q: one(sp.q),
    tier: one(sp.nivel),
    seg: ["frequent", "inactive", "birthday", "marketing"].includes(seg ?? "") ? seg : "",
    page: Number(one(sp.p) || 1) || 1,
  };
  const [list, counts, tiers] = await Promise.all([listCustomers(filters), customerCounts(), loyaltyTiers()]);
  const canWrite = hasPermission(session, "customers.write");
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { q: filters.q, nivel: filters.tier, seg: filters.seg, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/clientes${s ? `?${s}` : ""}`;
  };
  const segments: Array<{ key: CustomerFilters["seg"]; label: string; n: number }> = [
    { key: "", label: "Todos", n: counts.total },
    { key: "frequent", label: "Frecuentes", n: counts.frequent },
    { key: "inactive", label: "Inactivos +30 días", n: counts.inactive },
    { key: "birthday", label: "Cumpleaños del mes", n: counts.birthday },
    { key: "marketing", label: "Con consentimiento", n: counts.marketing },
  ];
  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle={`${counts.total} clientes activos`}
        actions={canWrite ? <LinkButton href="/clientes/nuevo">Nuevo cliente</LinkButton> : undefined}
      />
      <form className="card mb-4 flex flex-wrap items-end gap-2 p-3" action="/clientes" method="get">
        <div className="min-w-[220px] flex-1">
          <label className="label" htmlFor="q">
            Buscar
          </label>
          <input
            id="q"
            name="q"
            className="input"
            placeholder="Nombre, teléfono, email o código PDP-000123"
            defaultValue={filters.q}
          />
        </div>
        <div>
          <label className="label" htmlFor="nivel">
            Nivel
          </label>
          <select id="nivel" name="nivel" className="input" defaultValue={filters.tier}>
            <option value="">Todos</option>
            {tiers.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        {filters.seg && <input type="hidden" name="seg" value={filters.seg} />}
        <button className="btn btn-primary">Buscar</button>
        {(filters.q || filters.tier || filters.seg) && (
          <Link href="/clientes" className="btn btn-secondary">
            Limpiar
          </Link>
        )}
      </form>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Segmentos">
        {segments.map((s) => (
          <Link
            key={s.key ?? "all"}
            href={qs({ seg: s.key || undefined })}
            role="tab"
            aria-selected={(filters.seg ?? "") === (s.key ?? "")}
            className={`pill px-3 py-1.5 text-sm font-medium ${(filters.seg ?? "") === (s.key ?? "") ? "bg-teal text-white" : "st-gray"}`}
          >
            {s.label} <span className="opacity-70">· {s.n}</span>
          </Link>
        ))}
      </div>
      {list.rows.length === 0 ? (
        <EmptyState
          title="Sin resultados"
          body="Prueba con otro nombre, teléfono o código, o quita los filtros."
          action={canWrite ? <LinkButton href="/clientes/nuevo">Registrar cliente</LinkButton> : undefined}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Nivel</th>
              <th className="text-right">Puntos</th>
              <th className="text-right">Compras</th>
              <th className="text-right">Gasto</th>
              <th>Última compra</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((c) => (
              <tr key={c.id} className="hover:bg-black/[0.02]">
                <td className="font-mono text-xs">
                  <Link href={`/clientes/${c.id}`} className="text-teal-d hover:underline">
                    {c.public_code}
                  </Link>
                </td>
                <td>
                  <Link href={`/clientes/${c.id}`} className="font-medium hover:underline">
                    {c.full_name}
                  </Link>
                  {c.marketing_consent && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">mkt</span>
                  )}
                </td>
                <td className="tabular-nums">{c.phone ?? c.email ?? "—"}</td>
                <td>{c.tier_name ? <Badge tone={tierTone(c.tier_color)}>{c.tier_name}</Badge> : "—"}</td>
                <td className="text-right tabular-nums">{c.points_balance}</td>
                <td className="text-right tabular-nums">{c.total_orders}</td>
                <td className="text-right">
                  <Money cents={c.total_spent_cents} compact />
                </td>
                <td className="text-muted">{fmtDate(c.last_purchase_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.pages > 1 && (
        <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Paginación">
          <span className="text-muted">
            Página {list.page} de {list.pages} · {list.total} clientes
          </span>
          <div className="flex gap-2">
            {list.page > 1 && (
              <Link className="btn btn-secondary btn-sm" href={qs({ p: String(list.page - 1) })}>
                Anterior
              </Link>
            )}
            {list.page < list.pages && (
              <Link className="btn btn-secondary btn-sm" href={qs({ p: String(list.page + 1) })}>
                Siguiente
              </Link>
            )}
          </div>
        </nav>
      )}
    </>
  );
}
