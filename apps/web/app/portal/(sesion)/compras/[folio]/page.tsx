import Link from "next/link";
import { notFound } from "next/navigation";
import { dateMX, dateTimeMX, money } from "@/lib/format";
import {
  FULFILLMENT_LABELS,
  getPortalPurchase,
  PAYMENT_METHOD_LABELS,
  PURCHASE_CHANNEL_LABELS,
} from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";

export const metadata = { title: "Detalle de compra", robots: { index: false, follow: false } };

/** Cantidades con decimales solo cuando los hay ("2" y no "2.000"). */
function qtyLabel(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3)));
}

export default async function PortalPurchaseDetailPage({
  params,
}: {
  params: Promise<{ folio: string }>;
}) {
  const session = await requireCustomerSession();
  const { folio } = await params;
  // La consulta filtra por el cliente de la SESIÓN: el folio de otra persona no existe aquí → 404.
  const purchase = await getPortalPurchase(session.customer.id, decodeURIComponent(folio));
  if (!purchase) notFound();
  const business = await getBusiness();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/portal/compras" className="text-sm text-sage underline">
          ← Todas mis compras
        </Link>
        <h1 className="mt-2 font-display text-2xl text-ink" data-testid="portal-detalle-folio">
          {purchase.folio}
        </h1>
        <p className="mt-1 text-sm text-ink-2" data-testid="portal-detalle-fecha">
          {dateTimeMX(purchase.soldAt, business.timezone)} ·{" "}
          {PURCHASE_CHANNEL_LABELS[purchase.channel] ?? "Compra"}
        </p>
      </div>

      {purchase.voided && (
        <p
          className="rounded-card border border-wine/40 bg-wine/10 px-4 py-3 text-sm text-ink"
          role="status"
          data-testid="portal-detalle-cancelada"
        >
          Esta compra fue cancelada. Si te quedó alguna duda, escríbenos y la revisamos contigo.
        </p>
      )}

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Lo que llevaste</h2>
        <ul className="mt-3 divide-y divide-line" data-testid="portal-detalle-items">
          {purchase.items.map((i, idx) => (
            <li key={`${i.name}-${idx}`} className="py-3">
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{qtyLabel(i.qty)} ×</span> {i.name}
                  {i.variantLabel && <span className="text-ink-2"> · {i.variantLabel}</span>}
                  <span className="mt-0.5 block text-xs text-ink-2">
                    {money(i.unitPriceCents)} c/u
                    {i.discountCents > 0 ? ` · descuento ${money(i.discountCents)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-ink">{money(i.totalCents)}</span>
              </div>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
          <Row label="Subtotal" value={money(purchase.subtotalCents)} />
          {purchase.discountCents > 0 && (
            <Row
              label={`Descuento${purchase.couponCode ? ` (${purchase.couponCode})` : ""}`}
              value={`−${money(purchase.discountCents)}`}
              tone="sage"
            />
          )}
          {purchase.deliveryFeeCents > 0 && (
            <Row label="Envío" value={money(purchase.deliveryFeeCents)} />
          )}
          {purchase.taxCents > 0 && <Row label="IVA" value={money(purchase.taxCents)} />}
          {purchase.tipCents > 0 && <Row label="Propina" value={money(purchase.tipCents)} />}
          <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums" data-testid="portal-detalle-total">
              {money(purchase.totalCents)}
            </dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-display text-xl text-ink">Cómo pagaste</h2>
          {purchase.payments.length === 0 ? (
            <p className="mt-2 text-sm text-ink-2">Sin pagos registrados.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm" data-testid="portal-detalle-pagos">
              {purchase.payments.map((p, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-ink-2">
                    {PAYMENT_METHOD_LABELS[p.method] ?? "Otro método"}
                  </span>
                  <span className="tabular-nums text-ink">{money(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5">
          <h2 className="font-display text-xl text-ink">Entrega y puntos</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">Modalidad</dt>
              <dd className="text-right text-ink">
                {FULFILLMENT_LABELS[purchase.fulfillmentType] ?? "Entrega"}
              </dd>
            </div>
            {purchase.pickupPointName && (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">Lugar</dt>
                <dd className="text-right text-ink">{purchase.pickupPointName}</dd>
              </div>
            )}
            {purchase.scheduledFor && (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-2">Fecha acordada</dt>
                <dd className="text-right text-ink">
                  {dateMX(purchase.scheduledFor, business.timezone)}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-ink-2">Puntos ganados</dt>
              <dd className="text-right font-semibold text-ink" data-testid="portal-detalle-puntos">
                {purchase.pointsEarned > 0 ? `+${purchase.pointsEarned}` : "0"}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink-2">
            <Link href="/portal/puntos" className="text-sage underline">
              Ver todos mis movimientos de puntos
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "sage" }) {
  return (
    <div className={`flex justify-between ${tone === "sage" ? "text-sage" : ""}`}>
      <dt className={tone ? "" : "text-ink-2"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
