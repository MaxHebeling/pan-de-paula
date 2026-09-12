import { Card, Table, Money, Badge } from "@/components/ui";
import { money, qty, pct } from "@/lib/format";
import { products } from "@/lib/reports";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Rentabilidad por producto" };
export const dynamic = "force-dynamic";

export default async function ProductsReport({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reportContext(await searchParams, "productos", (d) => ({ from: d.last30, to: d.today }));
  const rows = await products(ctx.range.from, ctx.range.to);
  const withSales = rows.filter((r) => Number(r.sold) > 0);
  const totals = withSales.reduce(
    (a, r) => ({ revenue: a.revenue + r.revenue_cents, cost: a.cost + (r.cost_cents ?? 0), missing: a.missing || r.cost_cents === null, sold: a.sold + Number(r.sold), waste: a.waste + Number(r.waste) }),
    { revenue: 0, cost: 0, missing: false, sold: 0, waste: 0 },
  );
  const fmt = (v: number) => money(v, { compact: true });
  return (
    <ReportShell ctx={ctx} title="Rentabilidad por producto">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Ingresos por producto (top 10)">
          <Bars items={withSales.slice(0, 10).map((r) => ({ label: r.product_name, value: r.revenue_cents, hint: `${qty(r.sold)} uds` }))} format={fmt} />
        </Card>
        <Card title="Utilidad por producto (top 10)">
          {withSales.some((r) => r.profit_cents !== null) ? (
            <Bars
              items={withSales
                .filter((r) => r.profit_cents !== null)
                .sort((a, b) => (b.profit_cents ?? 0) - (a.profit_cents ?? 0))
                .slice(0, 10)
                .map((r) => ({ label: r.product_name, value: r.profit_cents ?? 0, hint: `margen ${pct(r.margin_bps)}` }))}
              format={fmt}
              tone="green"
            />
          ) : (
            <p className="text-sm text-muted">Sin costos capturados: agrega recetas para ver utilidad.</p>
          )}
        </Card>
        <Card title="Totales del periodo">
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            <dt className="text-muted">Unidades vendidas</dt>
            <dd className="text-right tabular-nums">{qty(totals.sold)}</dd>
            <dt className="text-muted">Ingresos (neto de descuentos)</dt>
            <dd className="text-right">
              <Money cents={totals.revenue} />
            </dd>
            <dt className="text-muted">Costo</dt>
            <dd className="text-right">{totals.missing ? "incompleto" : <Money cents={totals.cost} />}</dd>
            <dt className="font-medium">Utilidad</dt>
            <dd className="text-right font-medium">{totals.missing ? "—" : <Money cents={totals.revenue - totals.cost} />}</dd>
            <dt className="text-muted">Margen</dt>
            <dd className="text-right tabular-nums">{totals.missing || !totals.revenue ? "—" : `${Math.round(((totals.revenue - totals.cost) / totals.revenue) * 1000) / 10}%`}</dd>
            <dt className="text-muted">Merma total</dt>
            <dd className="text-right tabular-nums">{qty(totals.waste)} uds</dd>
          </dl>
        </Card>
      </div>
      <div className="mt-4">
        <Table>
          <thead>
            <tr>
              <th>Producto</th>
              <th className="text-right">Producido</th>
              <th className="text-right">Vendido</th>
              <th className="text-right">Merma</th>
              <th className="text-right">Stock</th>
              <th className="text-right">Ingresos</th>
              <th className="text-right">Costo</th>
              <th className="text-right">Utilidad</th>
              <th className="text-right">Margen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_id}>
                <td>
                  <div className="font-medium">{r.product_name}</div>
                  {r.category_name && <div className="text-xs text-muted">{r.category_name}</div>}
                </td>
                <td className="text-right tabular-nums">{qty(r.produced)}</td>
                <td className="text-right tabular-nums">{qty(r.sold)}</td>
                <td className="text-right tabular-nums">{Number(r.waste) > 0 ? <span className="text-red-d">{qty(r.waste)}</span> : "0"}</td>
                <td className="text-right tabular-nums">{qty(r.on_hand)}</td>
                <td className="text-right">
                  <Money cents={r.revenue_cents} compact />
                </td>
                <td className="text-right">{r.cost_cents === null ? <Badge tone="amber">sin costo</Badge> : <Money cents={r.cost_cents} compact />}</td>
                <td className="text-right">{r.profit_cents === null ? "—" : <Money cents={r.profit_cents} compact className={r.profit_cents < 0 ? "text-red-d" : ""} />}</td>
                <td className="text-right tabular-nums">{pct(r.margin_bps)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </ReportShell>
  );
}
