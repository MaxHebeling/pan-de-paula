import { Card, Table, Money } from "@/components/ui";
import { money, qty, fmtDate } from "@/lib/format";
import { waste, wasteDetail, WASTE_LABELS } from "@/lib/reports";
import { reportContext, ReportShell } from "@/components/reports/report-shell";
import { CompareStat } from "@/components/reports/compare";
import { Bars } from "@/components/reports/bars";

export const metadata = { title: "Mermas" };
export const dynamic = "force-dynamic";

export default async function WasteReport({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reportContext(await searchParams, "mermas", (d) => ({ from: d.monthStart, to: d.today }));
  const { range } = ctx;
  const [cur, prev, detail] = await Promise.all([waste(range.from, range.to), waste(range.prevFrom, range.prevTo), wasteDetail(range.from, range.to)]);
  const sum = (rows: typeof cur) => rows.reduce((a, r) => ({ qty: a.qty + Number(r.qty), cost: a.cost + r.cost_cents, n: a.n + r.count }), { qty: 0, cost: 0, n: 0 });
  const c = sum(cur);
  const p = sum(prev);
  const fmt = (v: number) => money(v, { compact: true });
  const byProduct = Object.values(
    detail.reduce<Record<string, { name: string; qty: number; cost: number }>>((acc, r) => {
      const x = (acc[r.product_name] ??= { name: r.product_name, qty: 0, cost: 0 });
      x.qty += Number(r.qty);
      x.cost += r.cost_cents;
      return acc;
    }, {}),
  ).sort((a, b) => b.qty - a.qty);
  return (
    <ReportShell ctx={ctx} title="Mermas por motivo">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <CompareStat label="Unidades mermadas" value={qty(c.qty)} current={c.qty} previous={p.qty} invert />
        <CompareStat label="Costo de la merma" value={<Money cents={c.cost} />} current={c.cost} previous={p.cost} format={fmt} invert />
        <CompareStat label="Registros" value={c.n} current={c.n} previous={p.n} invert />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Por motivo">
          {cur.length === 0 ? (
            <p className="text-sm text-muted">Sin mermas en el periodo.</p>
          ) : (
            <>
              <Bars items={cur.map((r) => ({ label: WASTE_LABELS[r.reason] ?? r.reason, value: Number(r.qty), hint: `${fmt(r.cost_cents)} · ${r.count} registros` }))} tone="amber" />
              <Table className="mt-3 !border-0 !shadow-none">
                <thead>
                  <tr>
                    <th>Motivo</th>
                    <th className="text-right">Registros</th>
                    <th className="text-right">Unidades</th>
                    <th className="text-right">Costo</th>
                    <th className="text-right">% uds</th>
                  </tr>
                </thead>
                <tbody>
                  {cur.map((r) => (
                    <tr key={r.reason}>
                      <td>{WASTE_LABELS[r.reason] ?? r.reason}</td>
                      <td className="text-right tabular-nums">{r.count}</td>
                      <td className="text-right tabular-nums">{qty(r.qty)}</td>
                      <td className="text-right">
                        <Money cents={r.cost_cents} compact />
                      </td>
                      <td className="text-right tabular-nums">{c.qty ? Math.round((Number(r.qty) / c.qty) * 100) : 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Card>
        <Card title="Por producto">
          {byProduct.length === 0 ? <p className="text-sm text-muted">Sin mermas en el periodo.</p> : <Bars items={byProduct.slice(0, 12).map((r) => ({ label: r.name, value: r.qty, hint: fmt(r.cost) }))} tone="red" />}
        </Card>
      </div>
      <div className="mt-4">
        <Table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Producto</th>
              <th className="text-right">Cantidad</th>
              <th>Motivo</th>
              <th className="text-right">Costo</th>
              <th>Nota</th>
              <th>Registró</th>
            </tr>
          </thead>
          <tbody>
            {detail.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-muted">{fmtDate(r.occurred_at, "datetime")}</td>
                <td>{r.product_name}</td>
                <td className="text-right tabular-nums">{qty(r.qty)}</td>
                <td>{WASTE_LABELS[r.reason] ?? r.reason}</td>
                <td className="text-right">
                  <Money cents={r.cost_cents} compact />
                </td>
                <td className="text-muted">{r.note ?? "—"}</td>
                <td className="text-muted">{r.staff_name ?? "—"}</td>
              </tr>
            ))}
            {detail.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted">
                  Sin registros.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
    </ReportShell>
  );
}
