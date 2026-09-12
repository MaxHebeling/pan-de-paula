import { Card, Table, Money, Alert } from "@/components/ui";
import { money, qty } from "@/lib/format";
import { summary, dailySeries, topProducts, customers } from "@/lib/reports";
import { CHANNEL_LABELS } from "@/lib/customers";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { CompareStat, Delta } from "@/components/reports/compare";
import { Bars, Columns } from "@/components/reports/bars";

export const metadata = { title: "Reporte mensual" };
export const dynamic = "force-dynamic";

export default async function MonthlyReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await reportContext(await searchParams, "mensual", (d) => ({
    from: d.monthStart,
    to: d.today,
  }));
  const { range } = ctx;
  const [cur, prev, series, top, cust, custPrev] = await Promise.all([
    summary(range.from, range.to),
    summary(range.prevFrom, range.prevTo),
    dailySeries(range.from, range.to),
    topProducts(range.from, range.to, 10),
    customers(range.from, range.to),
    customers(range.prevFrom, range.prevTo),
  ]);
  const fmt = (v: number) => money(v, { compact: true });
  const costOk = cur.sales.cost_missing === 0 && cur.sales.count > 0;
  const profit = costOk ? cur.net_cents - cur.sales.cost_cents : null;
  const prevProfit =
    prev.sales.cost_missing === 0 && prev.sales.count > 0
      ? prev.net_cents - prev.sales.cost_cents
      : null;
  const margin =
    profit !== null && cur.net_cents > 0 ? Math.round((profit / cur.net_cents) * 1000) / 10 : null;
  const web = cur.channels.find((c) => c.channel === "web");
  const pos = cur.channels.find((c) => c.channel === "pos");
  return (
    <ReportShell ctx={ctx} title="Reporte mensual">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CompareStat
          label="Facturación neta"
          value={<Money cents={cur.net_cents} />}
          current={cur.net_cents}
          previous={prev.net_cents}
          format={fmt}
          hint={`bruto ${fmt(cur.sales.gross_cents)}${cur.refunds_cents ? ` · reembolsos ${fmt(cur.refunds_cents)}` : ""}`}
        />
        <CompareStat
          label="Costos (snapshot)"
          value={costOk ? <Money cents={cur.sales.cost_cents} /> : "incompleto"}
          current={cur.sales.cost_cents}
          previous={prev.sales.cost_cents}
          format={fmt}
          invert
        />
        <CompareStat
          label="Utilidad bruta"
          value={profit === null ? "—" : <Money cents={profit} />}
          current={profit ?? 0}
          previous={prevProfit ?? 0}
          format={fmt}
          hint={margin !== null ? `margen ${margin}%` : "faltan costos"}
        />
        <CompareStat
          label="Ventas"
          value={cur.sales.count}
          current={cur.sales.count}
          previous={prev.sales.count}
          hint={`ticket ${fmt(cur.sales.ticket_cents)}`}
        />
        <CompareStat
          label="Ticket promedio"
          value={<Money cents={cur.sales.ticket_cents} />}
          current={cur.sales.ticket_cents}
          previous={prev.sales.ticket_cents}
          format={fmt}
        />
        <CompareStat
          label="Clientes que compraron"
          value={cust.buying}
          current={cust.buying}
          previous={custPrev.buying}
          hint={`${cust.new} nuevos · ${cust.recurring} recurrentes`}
        />
        <CompareStat
          label="Producción"
          value={`${qty(cur.production.qty)} uds`}
          current={Number(cur.production.qty)}
          previous={Number(prev.production.qty)}
          hint={`${cur.production.batches} lotes · costo ${fmt(cur.production.cost_cents)}`}
        />
        <CompareStat
          label="Mermas"
          value={`${qty(cur.waste.qty)} uds`}
          current={Number(cur.waste.qty)}
          previous={Number(prev.waste.qty)}
          invert
          hint={`costo ${fmt(cur.waste.cost_cents)}`}
        />
      </div>
      {!costOk && cur.sales.count > 0 && (
        <div className="mt-4">
          <Alert tone="amber">
            {cur.sales.cost_missing} venta(s) sin costo completo: la utilidad y el margen se
            muestran solo cuando todas las ventas tienen costo snapshot.
          </Alert>
        </div>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Ingresos netos por día" className="lg:col-span-2">
          <Columns
            items={series.map((r) => ({ label: r.day, value: r.revenue_cents - r.refunds_cents }))}
            format={fmt}
            height={120}
          />
          <p className="mt-2 text-xs text-muted">
            Máximo {fmt(Math.max(0, ...series.map((r) => r.revenue_cents - r.refunds_cents)))} ·
            variación vs. periodo anterior{" "}
            <Delta current={cur.net_cents} previous={prev.net_cents} />
          </p>
        </Card>
        <Card title="Web vs. mostrador">
          <Bars
            items={cur.channels.map((c) => ({
              label: CHANNEL_LABELS[c.channel] ?? c.channel,
              value: c.revenue_cents,
              hint: `${c.count} ventas`,
            }))}
            format={fmt}
          />
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">Web</dt>
            <dd className="text-right tabular-nums">
              {web?.count ?? 0} ventas · {web ? fmt(web.revenue_cents) : fmt(0)}
            </dd>
            <dt className="text-muted">Mostrador</dt>
            <dd className="text-right tabular-nums">
              {pos?.count ?? 0} ventas · {pos ? fmt(pos.revenue_cents) : fmt(0)}
            </dd>
            <dt className="text-muted">Pedidos web / POS</dt>
            <dd className="text-right tabular-nums">
              {cur.orders.web} / {cur.orders.pos}
            </dd>
          </dl>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Productos del periodo">
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="text-right">Unidades</th>
                <th className="text-right">Ingresos</th>
              </tr>
            </thead>
            <tbody>
              {top.map((t) => (
                <tr key={t.product_name}>
                  <td>{t.product_name}</td>
                  <td className="text-right tabular-nums">{qty(t.units)}</td>
                  <td className="text-right">
                    <Money cents={t.revenue_cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card title="Comparación con el periodo anterior">
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Indicador</th>
                <th className="text-right">Actual</th>
                <th className="text-right">Anterior</th>
                <th className="text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Facturación neta", cur.net_cents, prev.net_cents, true, false],
                  ["Reembolsos", cur.refunds_cents, prev.refunds_cents, true, true],
                  ["Descuentos", cur.sales.discount_cents, prev.sales.discount_cents, true, true],
                  ["Ventas", cur.sales.count, prev.sales.count, false, false],
                  ["Unidades", Number(cur.sales.units), Number(prev.sales.units), false, false],
                  ["Clientes nuevos", cur.customers_new, prev.customers_new, false, false],
                  [
                    "Producción (uds)",
                    Number(cur.production.qty),
                    Number(prev.production.qty),
                    false,
                    false,
                  ],
                  ["Mermas (uds)", Number(cur.waste.qty), Number(prev.waste.qty), false, true],
                  ["Puntos emitidos", cust.points.issued, custPrev.points.issued, false, false],
                ] as Array<[string, number, number, boolean, boolean]>
              ).map(([label, a, b, isMoney, invert]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="text-right tabular-nums">
                    {isMoney ? fmt(a) : a.toLocaleString("es-MX")}
                  </td>
                  <td className="text-right tabular-nums text-muted">
                    {isMoney ? fmt(b) : b.toLocaleString("es-MX")}
                  </td>
                  <td className="text-right">
                    <Delta current={a} previous={b} invert={invert} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </ReportShell>
  );
}
