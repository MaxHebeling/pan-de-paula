import { notFound } from "next/navigation";
import { formatMXN } from "@pdp/domain";
import { requireSession } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { getRegisterSummary } from "@/lib/pos";
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
  const meta = await sql<{
    opened_by: string;
    closed_by: string | null;
    notes: string | null;
    name: string;
  }>`
    select o.full_name as opened_by, c.full_name as closed_by, rs.notes, bs.name
    from register_sessions rs join staff_users o on o.id = rs.opened_by left join staff_users c on c.id = rs.closed_by
    cross join business_settings bs where rs.id = ${sessionId}::uuid`.execute(db());
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
