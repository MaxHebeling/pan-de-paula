import Link from "next/link";
import { PAYMENT_METHOD_LABELS } from "@pdp/domain";
import { Card, Money, Table } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { paymentsDetail, PAYMENT_LABELS } from "@/lib/reports";
import { NO_REFERENCE } from "@/components/ops/payment-lines";
import { reportContext, ReportShell } from "@/components/reports/report-shell";

export const metadata = { title: "Pagos y referencias" };
export const dynamic = "force-dynamic";

const METHODS = Object.keys(PAYMENT_METHOD_LABELS);
const one = (sp: Record<string, string | string[] | undefined>, k: string) =>
  (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) ?? "";

/**
 * Pagos del periodo al grano de la conciliación: una fila por PAGO, con su método, su monto y su
 * referencia contable. En una venta con varios pagos cada parte tiene su renglón, así que nunca se
 * pierde qué referencia va con qué método y con qué monto. Los pagos sin referencia muestran "—".
 */
export default async function PaymentsReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const ctx = await reportContext(sp, "pagos", (d) => ({ from: d.monthStart, to: d.today }));
  const metodoRaw = one(sp, "metodo");
  const metodo = METHODS.includes(metodoRaw) ? metodoRaw : "";
  const ref = one(sp, "ref").trim().slice(0, 80);
  const rows = await paymentsDetail(ctx.range.from, ctx.range.to, { metodo, ref });
  const total = rows.reduce((a, r) => a + r.amount_cents - r.refunded_cents, 0);
  const withRef = rows.filter((r) => r.reference).length;
  const exportParams =
    (metodo ? `&metodo=${encodeURIComponent(metodo)}` : "") +
    (ref ? `&ref=${encodeURIComponent(ref)}` : "");
  return (
    <ReportShell ctx={ctx} title="Pagos y referencias" exportParams={exportParams}>
      <form className="card no-print mb-4 flex flex-wrap items-end gap-2 p-3" method="get">
        <input type="hidden" name="from" value={ctx.range.from} />
        <input type="hidden" name="to" value={ctx.range.to} />
        <div>
          <label className="label" htmlFor="metodo">
            Método
          </label>
          <select id="metodo" name="metodo" className="input min-h-11" defaultValue={metodo}>
            <option value="">Todos</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="label" htmlFor="ref">
            Referencia
          </label>
          <input
            id="ref"
            name="ref"
            className="input min-h-11 font-mono"
            defaultValue={ref}
            placeholder="BANORTE-839201"
            maxLength={80}
            autoComplete="off"
          />
        </div>
        <button className="btn btn-primary min-h-11">Filtrar</button>
        {(metodo || ref) && (
          <Link
            href={`/reportes/pagos?from=${ctx.range.from}&to=${ctx.range.to}`}
            className="btn btn-secondary min-h-11"
          >
            Limpiar
          </Link>
        )}
      </form>
      <Card
        title={`Pagos (${rows.length})`}
        action={
          <span className="text-sm text-muted">
            neto <Money cents={total} /> · {withRef} con referencia
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Sin pagos con estos filtros.</p>
        ) : (
          <Table className="!border-0 !shadow-none">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Folio</th>
                <th>Método</th>
                <th>Referencia</th>
                <th className="text-right">Monto</th>
                <th className="text-right">Reembolsado</th>
                <th>Registró</th>
              </tr>
            </thead>
            <tbody data-testid="payments-report">
              {rows.map((r) => (
                <tr key={r.id} className={r.voided_at ? "text-muted line-through" : ""}>
                  <td className="whitespace-nowrap">{fmtDate(r.created_at, "datetime")}</td>
                  <td>
                    <Link
                      href={`/pedidos/${r.order_id}`}
                      className="font-mono text-xs text-teal-d hover:underline"
                    >
                      {r.folio}
                    </Link>
                  </td>
                  <td>{PAYMENT_LABELS[r.method] ?? r.method}</td>
                  <td
                    className={r.reference ? "font-mono text-xs" : "text-muted"}
                    data-testid="payment-reference"
                  >
                    {r.reference ?? NO_REFERENCE}
                  </td>
                  <td className="text-right">
                    <Money cents={r.amount_cents} />
                  </td>
                  <td className="text-right">
                    {r.refunded_cents ? (
                      <Money cents={r.refunded_cents} className="text-red-d" />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="text-xs text-muted">{r.staff_name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">
          La <strong>referencia</strong> es lo que captura el negocio para conciliar (clave de
          rastreo, folio de la terminal, id del depósito). El identificador del proveedor (Mercado
          Pago) va en la columna &ldquo;ID Mercado Pago&rdquo; del CSV y nunca se mezcla con ella.
        </p>
      </Card>
    </ReportShell>
  );
}
