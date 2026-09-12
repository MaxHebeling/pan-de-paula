import { formatMXN, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@pdp/domain";
import type { ReceiptView } from "@/lib/pos";
import { fmtDate } from "@/lib/format";

/** Estilos del ticket térmico de 80 mm (impresión) y vista previa en pantalla. */
export const RECEIPT_CSS = `
  .ticket { width: 72mm; max-width: 100%; margin: 0 auto; background: #fff; color: #000; font: 12px/1.35 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 4mm 3mm; }
  .ticket h1 { font-size: 15px; margin: 0; text-align: center; letter-spacing: .02em; }
  .ticket .c { text-align: center; }
  .ticket .muted { color: #444; }
  .ticket hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .ticket table { width: 100%; border-collapse: collapse; }
  .ticket td { padding: 1px 0; vertical-align: top; }
  .ticket td.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ticket .total td { font-weight: 700; font-size: 14px; padding-top: 3px; }
  .ticket .void { border: 2px solid #000; padding: 4px; text-align: center; font-weight: 700; margin: 6px 0; }
  @media print {
    @page { size: 80mm auto; margin: 0; }
    html, body { background: #fff !important; margin: 0; }
    .no-print { display: none !important; }
    .ticket { width: 72mm; padding: 3mm; }
  }
`;

export function Receipt({ r }: { r: ReceiptView }) {
  return (
    <article className="ticket" data-testid="receipt">
      <h1>{r.business.name}</h1>
      {r.business.tagline && <div className="c muted">{r.business.tagline}</div>}
      {r.business.legalName && <div className="c muted">{r.business.legalName}</div>}
      {r.business.address && <div className="c muted">{r.business.address}</div>}
      {(r.business.phone || r.business.whatsapp) && <div className="c muted">Tel. {r.business.phone ?? r.business.whatsapp}</div>}
      {r.business.instagram && <div className="c muted">@{r.business.instagram.replace(/^@/, "")}</div>}
      <hr />
      <table>
        <tbody>
          <tr>
            <td>Ticket</td>
            <td className="r">
              <strong>{r.folio}</strong>
            </td>
          </tr>
          <tr>
            <td>Fecha</td>
            <td className="r">{fmtDate(r.soldAt, "datetime")}</td>
          </tr>
          {r.staffName && (
            <tr>
              <td>Atendió</td>
              <td className="r">{r.staffName}</td>
            </tr>
          )}
          {r.customer && (
            <tr>
              <td>Cliente</td>
              <td className="r">
                {r.customer.name}
                {r.customer.code ? ` · ${r.customer.code}` : ""}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {r.voided && <div className="void">VENTA ANULADA</div>}
      <hr />
      <table>
        <tbody>
          {r.items.map((i, idx) => (
            <tr key={idx}>
              <td>
                {i.qty} × {i.name}
                {i.variantLabel ? ` (${i.variantLabel})` : ""}
                {i.discountCents > 0 && <div className="muted">desc. −{formatMXN(i.discountCents)}</div>}
                {i.notes && <div className="muted">{i.notes}</div>}
              </td>
              <td className="r">{formatMXN(i.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="r">{formatMXN(r.subtotalCents)}</td>
          </tr>
          {r.discountCents > 0 && (
            <tr>
              <td>Descuento{r.couponCode ? ` (${r.couponCode})` : ""}</td>
              <td className="r">−{formatMXN(r.discountCents)}</td>
            </tr>
          )}
          {r.taxCents > 0 && (
            <tr>
              <td>IVA</td>
              <td className="r">{formatMXN(r.taxCents)}</td>
            </tr>
          )}
          {r.tipCents > 0 && (
            <tr>
              <td>Propina</td>
              <td className="r">{formatMXN(r.tipCents)}</td>
            </tr>
          )}
          <tr className="total">
            <td>TOTAL</td>
            <td className="r">{formatMXN(r.totalCents)}</td>
          </tr>
        </tbody>
      </table>
      <hr />
      <table>
        <tbody>
          {r.payments.map((p, idx) => (
            <tr key={idx}>
              <td>
                {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}
                {p.reference ? <div className="muted">ref. {p.reference}</div> : null}
              </td>
              <td className="r">{formatMXN(p.amountCents)}</td>
            </tr>
          ))}
          {r.payments.some((p) => p.tenderedCents !== null) && (
            <>
              <tr>
                <td>Recibido</td>
                <td className="r">{formatMXN(r.payments.reduce((s, p) => s + (p.tenderedCents ?? p.amountCents), 0))}</td>
              </tr>
              <tr>
                <td>Cambio</td>
                <td className="r">{formatMXN(r.payments.reduce((s, p) => s + (p.changeCents ?? 0), 0))}</td>
              </tr>
            </>
          )}
          {r.refundedCents > 0 && (
            <tr>
              <td>Reembolsado</td>
              <td className="r">−{formatMXN(r.refundedCents)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {(r.pointsEarned > 0 || r.pointsBalance !== null) && (
        <>
          <hr />
          <table>
            <tbody>
              {r.pointsEarned > 0 && (
                <tr>
                  <td>Puntos ganados</td>
                  <td className="r">+{r.pointsEarned}</td>
                </tr>
              )}
              {r.pointsBalance !== null && (
                <tr>
                  <td>Saldo de puntos</td>
                  <td className="r">{r.pointsBalance}</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      <hr />
      <div className="c">¡Gracias por tu compra!</div>
      <div className="c muted">Hecho con amor · {r.business.name}</div>
    </article>
  );
}
