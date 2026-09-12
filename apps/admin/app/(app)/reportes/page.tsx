import { Card, Table, Money, Alert } from "@/components/ui";
import { money, qty } from "@/lib/format";
import { summary, dailySeries, topProducts, PAYMENT_LABELS } from "@/lib/reports";
import { CHANNEL_LABELS } from "@/lib/customers";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { CompareStat, Delta } from "@/components/reports/compare";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Reporte diario" };
export const dynamic = "force-dynamic";

export default async function DailyReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await reportContext(await searchParams, "diario", (d) => ({
    from: d.today,
    to: d.today,
  }));
  const { range } = ctx;
  const [cur, prev, series, top] = await Promise.all([
    summary(range.from, range.to),
    summary(range.prevFrom, range.prevTo),
    dailySeries(range.from, range.to),
    topProducts(range.from, range.to, 8),
  ]);
  const fmt = (v: number) => money(v, { compact: true });
  const profit =
    cur.sales.cost_missing === 0 && cur.sales.count > 0
      ? cur.net_cents - cur.sales.cost_cents
      : null;
  return (
    <ReportShell
      ctx={ctx}
      title={range.days === 1 ? "Reporte del día" : `Resumen de ${range.days} días`}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <CompareStat
          label="Ventas"
          value={cur.sales.count}
          current={cur.sales.count}
          previous={prev.sales.count}
        />
        <CompareStat
          label="Ingresos netos"
          value={<Money cents={cur.net_cents} />}
          current={cur.net_cents}
          previous={prev.net_cents}
          format={fmt}
          hint={cur.refunds_cents ? `reembolsos ${fmt(cur.refunds_cents)}` : undefined}
        />
        <CompareStat
          label="Unidades vendidas"
          value={qty(cur.sales.units)}
          current={Number(cur.sales.units)}
          previous={Number(prev.sales.units)}
        />
        <CompareStat
          label="Ticket promedio"
          value={<Money cents={cur.sales.ticket_cents} />}
          current={cur.sales.ticket_cents}
          previous={prev.sales.ticket_cents}
          format={fmt}
        />
        <CompareStat
          label="Clientes nuevos"
          value={cur.customers_new}
          current={cur.customers_new}
          previous={prev.customers_new}
        />
        <CompareStat
          label="Pedidos"
          value={cur.orders.count}
          current={cur.orders.count}
          previous={prev.orders.count}
          hint={`${cur.orders.web} web · ${cur.orders.pos} mostrador${cur.orders.cancelled ? ` · ${cur.orders.cancelled} cancelados` : ""}`}
        />
        <CompareStat
          label="Mermas"
          value={`${qty(cur.waste.qty)} uds`}
          current={Number(cur.waste.qty)}
          previous={Number(prev.waste.qty)}
          invert
          hint={`costo ${fmt(cur.waste.cost_cents)}`}
        />
        <CompareStat
          label="Producción"
          value={`${qty(cur.production.qty)} uds`}
          current={Number(cur.production.qty)}
          previous={Number(prev.production.qty)}
          hint={`${cur.production.batches} lotes`}
        />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Ingresos por método de pago">
          {cur.payments.length === 0 ? (
            <p className="text-sm text-muted">Sin pagos en el periodo.</p>
          ) : (
            <Bars
              items={cur.payments.map((p) => ({
                label: PAYMENT_LABELS[p.method] ?? p.method,
                value: p.amount_cents - p.refunded_cents,
                hint: `${p.count} pagos`,
              }))}
              format={fmt}
            />
          )}
        </Card>
        <Card title="Canales">
          {cur.channels.length === 0 ? (
            <p className="text-sm text-muted">Sin ventas en el periodo.</p>
          ) : (
            <Bars
              items={cur.channels.map((c) => ({
                label: CHANNEL_LABELS[c.channel] ?? c.channel,
                value: c.revenue_cents,
                hint: `${c.count} ventas · ${qty(c.units)} uds`,
              }))}
              format={fmt}
            />
          )}
        </Card>
        <Card title="Cierre del periodo">
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            <dt className="text-muted">Inventario final</dt>
            <dd className="text-right tabular-nums">{qty(cur.inventory_units)} uds</dd>
            <dt className="text-muted">Ingresos brutos</dt>
            <dd className="text-right">
              <Money cents={cur.sales.gross_cents} />
            </dd>
            <dt className="text-muted">Descuentos</dt>
            <dd className="text-right">
              −<Money cents={cur.sales.discount_cents} />
            </dd>
            <dt className="text-muted">Reembolsos</dt>
            <dd className="text-right">
              −<Money cents={cur.refunds_cents} />
            </dd>
            <dt className="text-muted">Costo de lo vendido</dt>
            <dd className="text-right">
              {cur.sales.cost_missing ? (
                `incompleto (${cur.sales.cost_missing} ventas sin costo)`
              ) : (
                <Money cents={cur.sales.cost_cents} />
              )}
            </dd>
            <dt className="font-medium">Utilidad bruta</dt>
            <dd className="text-right font-medium">
              {profit === null ? "—" : <Money cents={profit} />}
            </dd>
            <dt className="text-muted">Clientes identificados</dt>
            <dd className="text-right tabular-nums">
              {cur.sales.identified} de {cur.sales.count} ventas
            </dd>
            <dt className="text-muted">Cortes de caja</dt>
            <dd className="text-right tabular-nums">
              {cur.register.count}
              {cur.register.with_difference
                ? ` (${cur.register.with_difference} con diferencia)`
                : ""}
            </dd>
          </dl>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Productos más vendidos">
          {top.length === 0 ? (
            <p className="text-sm text-muted">Sin ventas.</p>
          ) : (
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
          )}
        </Card>
        <Card title={range.days === 1 ? "Detalle del día" : "Detalle por día"}>
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Día</th>
                <th className="text-right">Ventas</th>
                <th className="text-right">Ingresos</th>
                <th className="text-right">Unidades</th>
                <th className="text-right">Producción</th>
                <th className="text-right">Merma</th>
                <th className="text-right">Nuevos</th>
              </tr>
            </thead>
            <tbody>
              {series.map((r) => (
                <tr key={r.day}>
                  <td className="whitespace-nowrap">{r.day}</td>
                  <td className="text-right tabular-nums">{r.sales_count}</td>
                  <td className="text-right">
                    <Money cents={r.revenue_cents - r.refunds_cents} compact />
                  </td>
                  <td className="text-right tabular-nums">{qty(r.units)}</td>
                  <td className="text-right tabular-nums">{qty(r.production_qty)}</td>
                  <td className="text-right tabular-nums">{qty(r.waste_qty)}</td>
                  <td className="text-right tabular-nums">{r.new_customers}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-muted">
            Variación de ingresos vs. periodo anterior:{" "}
            <Delta current={cur.net_cents} previous={prev.net_cents} />
          </p>
        </Card>
      </div>
      {cur.sales.cost_missing > 0 && (
        <div className="mt-4">
          <Alert tone="amber">
            {cur.sales.cost_missing} venta(s) sin costo completo: captura las recetas faltantes para
            obtener utilidad exacta.
          </Alert>
        </div>
      )}
    </ReportShell>
  );
}
