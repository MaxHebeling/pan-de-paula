import { Table, Alert } from "@/components/ui";
import { qty } from "@/lib/format";
import { reconciliation } from "@/lib/reports";
import { reportContext, ReportShell } from "@/components/reports/report-shell";

export const metadata = { title: "Conciliación de inventario" };
export const dynamic = "force-dynamic";

export default async function InventoryReport({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reportContext(await searchParams, "inventario", (d) => ({ from: d.today, to: d.today }));
  const rows = await reconciliation(ctx.range.from, ctx.range.to);
  const totals = rows.reduce(
    (a, r) => ({ opening: a.opening + Number(r.opening), production: a.production + Number(r.production), sales: a.sales + Number(r.sales), waste: a.waste + Number(r.waste), corrections: a.corrections + Number(r.corrections), other: a.other + Number(r.other), closing: a.closing + Number(r.closing) }),
    { opening: 0, production: 0, sales: 0, waste: 0, corrections: 0, other: 0, closing: 0 },
  );
  const negatives = rows.filter((r) => Number(r.closing) < 0);
  return (
    <ReportShell ctx={ctx} title="Conciliación de inventario">
      <p className="mb-3 text-sm text-muted">Final = inicial + producción − ventas − mermas ± correcciones ± otros (devoluciones, anulaciones, iniciales). Solo productos con control de stock.</p>
      {negatives.length > 0 && (
        <div className="mb-3">
          <Alert tone="amber">
            {negatives.length} producto(s) con existencia negativa al cierre: {negatives.map((n) => n.product_name).join(", ")}. Registra producción o un conteo físico.
          </Alert>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <th>Producto</th>
            <th className="text-right">Inicial</th>
            <th className="text-right">+ Producción</th>
            <th className="text-right">− Ventas</th>
            <th className="text-right">− Mermas</th>
            <th className="text-right">± Correcciones</th>
            <th className="text-right">± Otros</th>
            <th className="text-right">Final</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product_id}>
              <td>{r.product_name}</td>
              <td className="text-right tabular-nums">{qty(r.opening)}</td>
              <td className="text-right tabular-nums text-green-d">{Number(r.production) ? `+${qty(r.production)}` : "0"}</td>
              <td className="text-right tabular-nums">{Number(r.sales) ? `−${qty(r.sales)}` : "0"}</td>
              <td className="text-right tabular-nums text-red-d">{Number(r.waste) ? `−${qty(r.waste)}` : "0"}</td>
              <td className="text-right tabular-nums">{qty(r.corrections)}</td>
              <td className="text-right tabular-nums">{qty(r.other)}</td>
              <td className={`text-right font-semibold tabular-nums ${Number(r.closing) < 0 ? "text-red-d" : ""}`}>{qty(r.closing)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td>Total</td>
            <td className="text-right tabular-nums">{qty(totals.opening)}</td>
            <td className="text-right tabular-nums">+{qty(totals.production)}</td>
            <td className="text-right tabular-nums">−{qty(totals.sales)}</td>
            <td className="text-right tabular-nums">−{qty(totals.waste)}</td>
            <td className="text-right tabular-nums">{qty(totals.corrections)}</td>
            <td className="text-right tabular-nums">{qty(totals.other)}</td>
            <td className="text-right tabular-nums">{qty(totals.closing)}</td>
          </tr>
        </tbody>
      </Table>
    </ReportShell>
  );
}
