import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { getRegisterSummary } from "@/lib/pos";
import type { PaymentLine } from "@/lib/payments";
import { Alert, Badge, Card, Money, PageHeader, Table } from "@/components/ui";
import { methodLabel, NO_REFERENCE } from "@/components/ops/payment-lines";
import { RegisterSummaryTable } from "@/components/pos/register-summary";

export const dynamic = "force-dynamic";
export const metadata = { title: "Corte de caja" };

export default async function CajaDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ cerrada?: string }>;
}) {
  await requireSession("pos.register");
  const { sessionId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) notFound();
  const summary = await getRegisterSummary(sessionId);
  if (!summary) notFound();
  const [meta, sales] = await Promise.all([
    sql<{ opened_by: string; closed_by: string | null; notes: string | null }>`
      select o.full_name as opened_by, c.full_name as closed_by, rs.notes
      from register_sessions rs join staff_users o on o.id = rs.opened_by left join staff_users c on c.id = rs.closed_by
      where rs.id = ${sessionId}::uuid`.execute(db()),
    sql<{
      order_id: string;
      folio: string;
      sold_at: Date;
      total_cents: number;
      voided_at: Date | null;
      payments: PaymentLine[] | null;
    }>`
      select s.order_id, o.folio, s.sold_at, s.total_cents, s.voided_at,
             (select jsonb_agg(jsonb_build_object('id', p.id, 'method', p.method::text, 'status', p.status::text,
                                                  'amountCents', p.amount_cents, 'reference', p.reference, 'externalId', p.external_id)
                               order by p.created_at)
                from payments p where p.order_id = o.id and p.status in ('paid','partially_refunded','refunded')) as payments
      from sales s join orders o on o.id = s.order_id
      where s.register_session_id = ${sessionId}::uuid order by s.sold_at desc`.execute(db()),
  ]);
  const m = meta.rows[0]!;
  return (
    <>
      <PageHeader
        title={`Corte ${fmtDate(summary.opened_at, "short")}`}
        subtitle={`Abrió ${m.opened_by} · ${fmtDate(summary.opened_at, "datetime")}${summary.closed_at ? ` · cerró ${m.closed_by ?? "—"} · ${fmtDate(summary.closed_at, "datetime")}` : ""}`}
        actions={
          <>
            <Link href="/caja" className="btn btn-secondary">
              Volver a caja
            </Link>
            <a
              href={`/corte/${sessionId}?print=1`}
              target="_blank"
              rel="noopener"
              className="btn btn-primary"
            >
              Imprimir corte
            </a>
          </>
        }
      />
      {sp.cerrada === "1" && (
        <div className="mb-4">
          <Alert tone={summary.difference_cents === 0 ? "green" : "amber"}>
            Caja cerrada.{" "}
            {summary.difference_cents === 0
              ? "Sin diferencia: el efectivo cuadró."
              : `Diferencia registrada: se notificó al encargado.`}
          </Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Resumen"
          action={
            <Badge tone={summary.status === "open" ? "green" : "gray"}>
              {summary.status === "open" ? "Abierta" : "Cerrada"}
            </Badge>
          }
        >
          <RegisterSummaryTable s={summary} />
          {m.notes && <p className="mt-3 text-sm text-muted">Observaciones: {m.notes}</p>}
        </Card>
        <Card title={`Ventas de la sesión (${sales.rows.length})`}>
          {sales.rows.length === 0 ? (
            <p className="text-sm text-muted">Sin ventas en esta sesión.</p>
          ) : (
            <Table className="!border-0 !shadow-none">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Hora</th>
                  <th>Método y referencia</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {sales.rows.map((r) => (
                  <tr key={r.order_id} className={r.voided_at ? "text-muted line-through" : ""}>
                    <td>
                      <Link
                        href={`/pos/ventas?q=${encodeURIComponent(r.folio)}`}
                        className="text-teal-d hover:underline"
                      >
                        {r.folio}
                      </Link>
                    </td>
                    <td>{fmtDate(r.sold_at, "time")}</td>
                    <td>
                      {(r.payments ?? []).length === 0 ? (
                        "—"
                      ) : (
                        <ul data-testid="payment-lines">
                          {(r.payments ?? []).map((p) => (
                            <li key={p.id} className="whitespace-nowrap">
                              {methodLabel(p.method)} <Money cents={p.amountCents} compact />
                              <span className="text-muted"> · ref. </span>
                              <span className={p.reference ? "font-mono text-xs" : "text-muted"}>
                                {p.reference ?? NO_REFERENCE}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="text-right">
                      <Money cents={r.total_cents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
