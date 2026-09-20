import { notFound } from "next/navigation";
import { formatMXN } from "@pdp/domain";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { getRegisterSummary } from "@/lib/pos";
import { methodLabel, NO_REFERENCE } from "@/components/ops/payment-lines";
import { RECEIPT_CSS } from "@/components/pos/receipt";
import { PrintBar } from "@/components/pos/print-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Corte de caja" };

/** Corte de caja imprimible en 80 mm, fuera del shell del CRM. */
export default async function CortePage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ print?: string }>;
}) {
  await requireSession("pos.register");
  const { sessionId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) notFound();
  const s = await getRegisterSummary(sessionId);
  if (!s) notFound();
  const [meta, movements] = await Promise.all([
    sql<{
      opened_by: string;
      closed_by: string | null;
      notes: string | null;
      name: string;
    }>`
    select o.full_name as opened_by, c.full_name as closed_by, rs.notes, bs.name
    from register_sessions rs join staff_users o on o.id = rs.opened_by left join staff_users c on c.id = rs.closed_by
    cross join business_settings bs where rs.id = ${sessionId}::uuid`.execute(db()),
    // Movimientos del turno, uno por PAGO (no por venta): en un cobro dividido cada parte trae su propio
    // método, monto y referencia contable, que es justo lo que se coteja contra el banco y la terminal.
    sql<{
      id: string;
      folio: string;
      method: string;
      amount_cents: number;
      reference: string | null;
    }>`
    select p.id, o.folio, p.method::text as method, p.amount_cents, p.reference
    from payments p join orders o on o.id = p.order_id
    where p.register_session_id = ${sessionId}::uuid and p.status in ('paid','partially_refunded','refunded')
    order by p.created_at limit 300`.execute(db()),
  ]);
  const m = meta.rows[0]!;
  const line = (label: string, value: string, strong = false) => (
    <tr key={label}>
      <td>{strong ? <strong>{label}</strong> : label}</td>
      <td className="r">{strong ? <strong>{value}</strong> : value}</td>
    </tr>
  );
  const diff = s.difference_cents ?? 0;
  return (
    <main className="min-h-dvh bg-bg px-3 py-4">
      <style dangerouslySetInnerHTML={{ __html: RECEIPT_CSS }} />
      <PrintBar autoPrint={sp.print === "1"} backHref={`/caja/${sessionId}`} />
      <div className="card mx-auto w-fit max-w-full p-2">
        <article className="ticket" data-testid="corte">
          <h1>{m.name}</h1>
          <div className="c">CORTE DE CAJA</div>
          <div className="c muted">
            {s.status === "closed" ? "Cerrada" : "Parcial (caja abierta)"}
          </div>
          <hr />
          <table>
            <tbody>
              {line("Apertura", fmtDate(s.opened_at, "datetime"))}
              {line("Abrió", m.opened_by)}
              {s.closed_at ? line("Cierre", fmtDate(s.closed_at, "datetime")) : null}
              {m.closed_by ? line("Cerró", m.closed_by) : null}
            </tbody>
          </table>
          <hr />
          <table>
            <tbody>
              {line("Fondo inicial", formatMXN(s.opening_cash_cents))}
              {line("Ventas efectivo", `+${formatMXN(s.cash_cents)}`)}
              {s.refunds_cash_cents
                ? line("Reemb. efectivo", `−${formatMXN(s.refunds_cash_cents)}`)
                : null}
              {line("Efectivo esperado", formatMXN(s.expected_cash_cents), true)}
              {s.counted_cash_cents !== null
                ? line("Efectivo contado", formatMXN(s.counted_cash_cents), true)
                : null}
              {s.counted_cash_cents !== null
                ? line(
                    "Diferencia",
                    `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${formatMXN(Math.abs(diff))}`,
                    true,
                  )
                : null}
            </tbody>
          </table>
          <hr />
          <table>
            <tbody>
              {line("Tarjeta", formatMXN(s.card_cents))}
              {line("Transferencia", formatMXN(s.transfer_cents))}
              {line("Mercado Pago", formatMXN(s.mercadopago_cents))}
              {s.other_cents ? line("Otros", formatMXN(s.other_cents)) : null}
              {s.refunds_other_cents
                ? line("Reemb. no efectivo", `−${formatMXN(s.refunds_other_cents)}`)
                : null}
            </tbody>
          </table>
          <hr />
          <table>
            <tbody>
              {line(`Ventas (${s.sales_count})`, formatMXN(s.sales_total_cents), true)}
              {s.voided_count ? line("Anuladas", String(s.voided_count)) : null}
              {line("Artículos", String(Number(s.items_count)))}
            </tbody>
          </table>
          {movements.rows.length > 0 && (
            <>
              <hr />
              <div className="c">MOVIMIENTOS Y REFERENCIAS</div>
              <table data-testid="corte-movimientos">
                <tbody>
                  {movements.rows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.folio}
                        <div className="muted">
                          {methodLabel(p.method)} · ref. {p.reference ?? NO_REFERENCE}
                        </div>
                      </td>
                      <td className="r">{formatMXN(p.amount_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {m.notes && (
            <>
              <hr />
              <div className="muted">Obs.: {m.notes}</div>
            </>
          )}
          <hr />
          <div className="c muted">Impreso {fmtDate(new Date(), "datetime")}</div>
          <br />
          <div className="c">______________________</div>
          <div className="c muted">Firma</div>
        </article>
      </div>
    </main>
  );
}
