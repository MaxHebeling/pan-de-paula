import { Stat, Table, Money, Badge } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { registerSessions } from "@/lib/reports";
import { reportContext, ReportShell } from "@/components/reports/report-shell";

export const metadata = { title: "Caja" };
export const dynamic = "force-dynamic";

export default async function RegisterReport({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reportContext(await searchParams, "caja", (d) => ({ from: d.monthStart, to: d.today }));
  const rows = await registerSessions(ctx.range.from, ctx.range.to);
  const closed = rows.filter((r) => r.status === "closed");
  const diff = closed.reduce((a, r) => a + (r.difference_cents ?? 0), 0);
  const withDiff = closed.filter((r) => (r.difference_cents ?? 0) !== 0).length;
  const salesTotal = rows.reduce((a, r) => a + r.sales_total_cents, 0);
  return (
    <ReportShell ctx={ctx} title="Sesiones de caja y diferencias">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sesiones" value={rows.length} hint={`${closed.length} cerradas${rows.length - closed.length ? ` · ${rows.length - closed.length} abierta` : ""}`} />
        <Stat label="Ventas en caja" value={<Money cents={salesTotal} compact />} />
        <Stat label="Diferencia acumulada" value={<Money cents={diff} />} tone={diff < 0 ? "red" : diff > 0 ? "amber" : "green"} hint={`${withDiff} cierres con diferencia`} />
        <Stat label="Diferencia promedio" value={closed.length ? <Money cents={Math.round(diff / closed.length)} /> : "—"} />
      </div>
      <div className="mt-4">
        <Table>
          <thead>
            <tr>
              <th>Apertura</th>
              <th>Cierre</th>
              <th>Responsable</th>
              <th className="text-right">Ventas</th>
              <th className="text-right">Fondo</th>
              <th className="text-right">Efectivo esperado</th>
              <th className="text-right">Contado</th>
              <th className="text-right">Diferencia</th>
              <th className="text-right">Terminal</th>
              <th className="text-right">Transf.</th>
              <th className="text-right">MP</th>
              <th>Notas</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{fmtDate(r.opened_at, "datetime")}</td>
                <td className="whitespace-nowrap">{r.closed_at ? fmtDate(r.closed_at, "datetime") : <Badge tone="amber">abierta</Badge>}</td>
                <td>
                  {r.opened_by}
                  {r.closed_by && r.closed_by !== r.opened_by && <span className="text-muted"> / {r.closed_by}</span>}
                </td>
                <td className="text-right tabular-nums">
                  {r.sales_count} · <Money cents={r.sales_total_cents} compact />
                </td>
                <td className="text-right">
                  <Money cents={r.opening_cash_cents} compact />
                </td>
                <td className="text-right">
                  <Money cents={r.expected_cash_cents} compact />
                </td>
                <td className="text-right">
                  <Money cents={r.counted_cash_cents} compact />
                </td>
                <td className="text-right">
                  {r.difference_cents === null ? "—" : <Money cents={r.difference_cents} className={r.difference_cents < 0 ? "font-semibold text-red-d" : r.difference_cents > 0 ? "font-semibold text-amber-d" : "text-green-d"} />}
                </td>
                <td className="text-right">
                  <Money cents={r.card_cents} compact />
                </td>
                <td className="text-right">
                  <Money cents={r.transfer_cents} compact />
                </td>
                <td className="text-right">
                  <Money cents={r.mercadopago_cents} compact />
                </td>
                <td className="max-w-[200px] truncate text-muted" title={r.notes ?? ""}>
                  {r.notes ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="text-muted">
                  Sin sesiones de caja en el periodo.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
    </ReportShell>
  );
}
