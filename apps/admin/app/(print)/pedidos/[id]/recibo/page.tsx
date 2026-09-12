import { Fragment } from "react";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { receiptData } from "@/lib/receipt";
import { renderReceiptHtml } from "@pdp/integrations";
import { formatMXN } from "@pdp/domain";
import { fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/ops/print-button";

export const metadata = { title: "Recibo" };
export const dynamic = "force-dynamic";

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Recibo imprimible (ticket). Usa la plantilla compartida de @pdp/integrations si está disponible; si no, la propia. */
export default async function ReciboPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession("orders.read");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const data = await receiptData(id);
  if (!data) notFound();
  let sharedHtml: string | null = null;
  try {
    sharedHtml = renderReceiptHtml(data);
  } catch (e) {
    // La plantilla compartida aún no está implementada: se usa la propia.
    console.info(
      "[recibo] renderReceiptHtml no disponible, usando plantilla local:",
      (e as Error).message,
    );
  }
  const paid = data.payments.reduce((a, p) => a + p.amountCents, 0);
  return (
    <>
      <style>{`@media print { .no-print { display: none !important; } @page { size: 80mm auto; margin: 4mm; } }`}</style>
      <div className="no-print mb-4 flex justify-between">
        <a href={`/pedidos/${id}`} className="btn btn-secondary">
          ← Pedido
        </a>
        <PrintButton label="Imprimir recibo" />
      </div>
      {sharedHtml ? (
        <div dangerouslySetInnerHTML={{ __html: sharedHtml }} />
      ) : (
        <article className="font-mono text-[13px] leading-snug" data-testid="receipt">
          <header className="mb-3 text-center">
            <div className="text-base font-bold uppercase tracking-wide">{data.businessName}</div>
            <div>Comprobante de pedido</div>
            <div className="mt-1">{data.folio}</div>
            <div>{fmtDate(data.soldAt, "datetime")}</div>
            {data.customerName && <div>Cliente: {data.customerName}</div>}
          </header>
          <table className="w-full">
            <tbody>
              {data.items.map((it, i) => (
                <tr key={i}>
                  <td className="py-0.5 align-top">
                    {it.qty} × {it.name}
                    <div className="text-[11px] text-muted">{formatMXN(it.unitPriceCents)} c/u</div>
                  </td>
                  <td className="py-0.5 text-right align-top tabular-nums">
                    {formatMXN(it.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="my-2 border-t border-dashed border-ink" />
          <dl className="grid grid-cols-2 gap-y-0.5">
            <dt>Subtotal</dt>
            <dd className="text-right tabular-nums">{formatMXN(data.subtotalCents)}</dd>
            {data.discountCents > 0 && (
              <>
                <dt>Descuento</dt>
                <dd className="text-right tabular-nums">−{formatMXN(data.discountCents)}</dd>
              </>
            )}
            <dt className="text-base font-bold">TOTAL</dt>
            <dd className="text-right text-base font-bold tabular-nums">
              {formatMXN(data.totalCents)}
            </dd>
            {data.payments.map((p, i) => (
              <Fragment key={i}>
                <dt>{p.method}</dt>
                <dd className="text-right tabular-nums">{formatMXN(p.amountCents)}</dd>
              </Fragment>
            ))}
            {paid < data.totalCents && (
              <>
                <dt>Por pagar</dt>
                <dd className="text-right tabular-nums">{formatMXN(data.totalCents - paid)}</dd>
              </>
            )}
          </dl>
          {(data.pointsEarned ?? 0) > 0 && (
            <p className="mt-2 text-center">
              Ganaste {data.pointsEarned} puntos
              {data.pointsBalance !== undefined ? ` · saldo ${data.pointsBalance}` : ""}
            </p>
          )}
          <footer className="mt-4 text-center">¡Gracias por tu preferencia!</footer>
        </article>
      )}
    </>
  );
}
