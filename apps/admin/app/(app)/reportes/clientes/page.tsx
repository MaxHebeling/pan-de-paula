import Link from "next/link";
import { Card, Table, Money, Badge } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { customers, inactiveCustomers } from "@/lib/reports";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { CompareStat } from "@/components/reports/compare";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Reporte de clientes" };
export const dynamic = "force-dynamic";

export default async function CustomersReport({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reportContext(await searchParams, "clientes", (d) => ({ from: d.last30, to: d.today }));
  const { range } = ctx;
  const [cur, prev, inactive30, inactive60] = await Promise.all([customers(range.from, range.to), customers(range.prevFrom, range.prevTo), inactiveCustomers(30, 30), inactiveCustomers(60, 30)]);
  const fmt = (v: number) => money(v, { compact: true });
  return (
    <ReportShell ctx={ctx} title="Clientes">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CompareStat label="Nuevos" value={cur.new} current={cur.new} previous={prev.new} />
        <CompareStat label="Compraron" value={cur.buying} current={cur.buying} previous={prev.buying} hint={`${cur.returning} ya habían comprado antes`} />
        <CompareStat label="Recurrentes (2+ compras)" value={cur.recurring} current={cur.recurring} previous={prev.recurring} />
        <CompareStat label="Puntos emitidos" value={cur.points.issued.toLocaleString("es-MX")} current={cur.points.issued} previous={prev.points.issued} hint={`${cur.points.redeemed} canjeados`} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Top clientes del periodo" className="lg:col-span-2">
          {cur.top.length === 0 ? (
            <p className="text-sm text-muted">Sin compras identificadas en el periodo.</p>
          ) : (
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Nivel</th>
                  <th className="text-right">Compras</th>
                  <th className="text-right">Gasto</th>
                  <th>Última</th>
                </tr>
              </thead>
              <tbody>
                {cur.top.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/clientes/${t.id}`} className="hover:underline">
                        {t.full_name}
                      </Link>{" "}
                      <span className="font-mono text-xs text-muted">{t.public_code}</span>
                    </td>
                    <td>{t.tier_key ? <Badge tone="gray">{cur.tiers.find((x) => x.tier_key === t.tier_key)?.name ?? t.tier_key}</Badge> : "—"}</td>
                    <td className="text-right tabular-nums">{t.sales}</td>
                    <td className="text-right">
                      <Money cents={t.spent_cents} compact />
                    </td>
                    <td className="text-muted">{fmtDate(t.last_purchase_at)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Por nivel">
          <Bars items={cur.tiers.map((t) => ({ label: t.name, value: t.customers, hint: `${t.sales} ventas · ${fmt(t.spent_cents)} en el periodo` }))} />
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">Clientes activos</dt>
            <dd className="text-right tabular-nums">{cur.total_active}</dd>
            <dt className="text-muted">Con consentimiento mkt</dt>
            <dd className="text-right tabular-nums">{cur.marketing_consent}</dd>
            <dt className="text-muted">Inactivos +30 días</dt>
            <dd className="text-right tabular-nums">{cur.inactive_30}</dd>
            <dt className="text-muted">Inactivos +60 días</dt>
            <dd className="text-right tabular-nums">{cur.inactive_60}</dd>
          </dl>
          {cur.sources.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Origen de los nuevos</div>
              <Bars items={cur.sources.map((s) => ({ label: s.source, value: s.count }))} />
            </div>
          )}
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {[
          ["Inactivos +30 días (mayor gasto)", inactive30],
          ["Inactivos +60 días (mayor gasto)", inactive60],
        ].map(([title, list]) => (
          <Card key={title as string} title={title as string} action={<Link href="/clientes?seg=inactive" className="text-sm text-teal-d hover:underline">Ver todos</Link>}>
            {(list as typeof inactive30).length === 0 ? (
              <p className="text-sm text-muted">Nadie en este grupo.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {(list as typeof inactive30).map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                    <Link href={`/clientes/${c.id}`} className="hover:underline">
                      {c.full_name} <span className="font-mono text-xs text-muted">{c.public_code}</span>
                    </Link>
                    <span className="whitespace-nowrap text-xs text-muted">
                      {c.total_orders} compras · <Money cents={c.total_spent_cents} compact /> · última {fmtDate(c.last_purchase_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </ReportShell>
  );
}
