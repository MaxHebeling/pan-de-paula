import { Card, Table, Money } from "@/components/ui";
import { money, qty } from "@/lib/format";
import { summary, PAYMENT_LABELS } from "@/lib/reports";
import { CHANNEL_LABELS } from "@/lib/customers";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { Delta } from "@/components/reports/compare";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Canales y métodos de pago" };
export const dynamic = "force-dynamic";

export default async function ChannelsReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await reportContext(await searchParams, "canales", (d) => ({
    from: d.monthStart,
    to: d.today,
  }));
  const { range } = ctx;
  const [cur, prev] = await Promise.all([
    summary(range.from, range.to),
    summary(range.prevFrom, range.prevTo),
  ]);
  const fmt = (v: number) => money(v, { compact: true });
  const totalPay = cur.payments.reduce((a, p) => a + p.amount_cents - p.refunded_cents, 0);
  return (
    <ReportShell ctx={ctx} title="Canales y métodos de pago">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ventas por canal">
          <Bars
            items={cur.channels.map((c) => ({
              label: CHANNEL_LABELS[c.channel] ?? c.channel,
              value: c.revenue_cents,
            }))}
            format={fmt}
          />
          <Table className="mt-3 !border-0 !shadow-none">
            <thead>
              <tr>
                <th>Canal</th>
                <th className="text-right">Ventas</th>
                <th className="text-right">Unidades</th>
                <th className="text-right">Ingresos</th>
                <th className="text-right">Ticket</th>
                <th className="text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {cur.channels.map((c) => {
                const p = prev.channels.find((x) => x.channel === c.channel);
                return (
                  <tr key={c.channel}>
                    <td>{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                    <td className="text-right tabular-nums">{c.count}</td>
                    <td className="text-right tabular-nums">{qty(c.units)}</td>
                    <td className="text-right">
                      <Money cents={c.revenue_cents} compact />
                    </td>
                    <td className="text-right">
                      <Money cents={c.count ? Math.round(c.revenue_cents / c.count) : 0} compact />
                    </td>
                    <td className="text-right">
                      <Delta current={c.revenue_cents} previous={p?.revenue_cents ?? 0} />
                    </td>
                  </tr>
                );
              })}
              {cur.channels.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">
                    Sin ventas en el periodo.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
        <Card title="Métodos de pago">
          <Bars
            items={cur.payments.map((p) => ({
              label: PAYMENT_LABELS[p.method] ?? p.method,
              value: p.amount_cents - p.refunded_cents,
            }))}
            format={fmt}
          />
          <Table className="mt-3 !border-0 !shadow-none">
            <thead>
              <tr>
                <th>Método</th>
                <th className="text-right">Pagos</th>
                <th className="text-right">Cobrado</th>
                <th className="text-right">Reembolsado</th>
                <th className="text-right">Neto</th>
                <th className="text-right">%</th>
                <th className="text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {cur.payments.map((p) => {
                const pv = prev.payments.find((x) => x.method === p.method);
                const net = p.amount_cents - p.refunded_cents;
                return (
                  <tr key={p.method}>
                    <td>{PAYMENT_LABELS[p.method] ?? p.method}</td>
                    <td className="text-right tabular-nums">{p.count}</td>
                    <td className="text-right">
                      <Money cents={p.amount_cents} compact />
                    </td>
                    <td className="text-right">
                      {p.refunded_cents ? (
                        <Money cents={p.refunded_cents} compact className="text-red-d" />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-right">
                      <Money cents={net} compact />
                    </td>
                    <td className="text-right tabular-nums">
                      {totalPay ? Math.round((net / totalPay) * 100) : 0}%
                    </td>
                    <td className="text-right">
                      <Delta
                        current={net}
                        previous={pv ? pv.amount_cents - pv.refunded_cents : 0}
                      />
                    </td>
                  </tr>
                );
              })}
              {cur.payments.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-muted">
                    Sin pagos en el periodo.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-muted">
            Pagos confirmados de ventas no anuladas, menos reembolsos completados del mismo pago.
          </p>
        </Card>
      </div>
    </ReportShell>
  );
}
