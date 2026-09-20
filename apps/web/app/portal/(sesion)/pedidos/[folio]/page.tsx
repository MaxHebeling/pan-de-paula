import Link from "next/link";
import { notFound } from "next/navigation";
import { ORDER_STATUS_LABELS, portalTimeline, PAYMENT_METHOD_LABELS } from "@pdp/domain";
import { LiveOrders } from "@/components/portal/LiveOrders";
import { MarkOrderRead } from "@/components/portal/MarkOrderRead";
import { OrderTimeline } from "@/components/portal/OrderTimeline";
import { dateTimeMX, money } from "@/lib/format";
import { FULFILLMENT_LABELS } from "@/lib/portal/data";
import { getPortalOrder, portalPulse } from "@/lib/portal/orders";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";

export const metadata = { title: "Seguimiento de pedido", robots: { index: false, follow: false } };

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente de pago",
  authorized: "Pago autorizado",
  partial: "Pago parcial",
  paid: "Pagado",
  failed: "Pago rechazado",
  refunded: "Reembolsado",
  partially_refunded: "Reembolsado en parte",
  cancelled: "Pago cancelado",
};

export default async function PortalOrderPage({ params }: { params: Promise<{ folio: string }> }) {
  const session = await requireCustomerSession();
  const { folio } = await params;
  const order = await getPortalOrder(session.customer.id, folio);
  // El folio de otra persona no existe para esta sesión: la consulta ya filtra por cliente.
  if (!order) notFound();

  const [business, pulse] = await Promise.all([getBusiness(), portalPulse(session.customer.id)]);
  const { steps, cancelled } = portalTimeline(order.status, order.fulfillmentType, order.history);
  const entrega = order.fulfillmentType === "delivery";

  return (
    <div className="space-y-6">
      <LiveOrders inicial={pulse} />
      {/* Abrir el seguimiento cuenta como leer sus avisos (al montar, no al precargar el enlace). */}
      <MarkOrderRead folio={order.folio} />

      <div>
        <Link href="/portal/pedidos" className="text-sm text-ink-2 underline">
          ← Mis pedidos
        </Link>
        <h1 className="mt-2 font-display text-2xl text-ink">Pedido {order.folio}</h1>
        <p className="text-sm text-ink-2">{dateTimeMX(order.placedAt, business.timezone)}</p>
      </div>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Estado de tu pedido</h2>
        {cancelled ? (
          <p className="mt-3 rounded-card border border-line bg-cream-2 px-4 py-3 text-sm text-ink">
            Este pedido está <strong>{ORDER_STATUS_LABELS[order.status].toLowerCase()}</strong>. Si
            no lo esperabas, escríbenos y lo revisamos.
          </p>
        ) : null}
        <OrderTimeline steps={steps} timezone={business.timezone} />
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Tu pedido</h2>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((i, n) => (
            <li key={n} className="flex items-baseline justify-between gap-4 py-2">
              <span className="text-ink">
                {i.qty} × {i.name}
                {i.variantLabel ? ` · ${i.variantLabel}` : ""}
                {i.notes ? <span className="block text-sm text-ink-2">{i.notes}</span> : null}
              </span>
              <span className="tabular-nums text-ink">{money(i.totalCents)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-4 space-y-1 border-t border-line pt-3 text-sm">
          <Row label="Subtotal" value={money(order.subtotalCents)} />
          {order.discountCents > 0 && (
            <Row
              label={order.couponCode ? `Descuento (${order.couponCode})` : "Descuento"}
              value={`− ${money(order.discountCents)}`}
            />
          )}
          {order.deliveryFeeCents > 0 && (
            <Row label="Envío" value={money(order.deliveryFeeCents)} />
          )}
          {order.tipCents > 0 && <Row label="Propina" value={money(order.tipCents)} />}
          <div className="flex items-baseline justify-between gap-4 pt-2">
            <dt className="font-display text-lg text-ink">Total</dt>
            <dd className="font-display text-xl text-ink" data-testid="portal-order-total">
              {money(order.totalCents)}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Pago y entrega</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field
            label="Pago"
            value={PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus}
            testId="portal-order-payment"
          />
          <Field
            label="Método"
            value={
              order.payments.length
                ? order.payments
                    .map(
                      (p) =>
                        PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ??
                        p.method,
                    )
                    .join(" · ")
                : "Se cobra al entregar"
            }
          />
          <Field
            label="Entrega"
            value={FULFILLMENT_LABELS[order.fulfillmentType] ?? order.fulfillmentType}
          />
          {order.scheduledFor && (
            <Field
              label={entrega ? "Te lo llevamos" : "Lo recoges"}
              value={dateTimeMX(order.scheduledFor, business.timezone)}
            />
          )}
          {entrega && order.deliveryAddress?.street && (
            <Field
              label="Dirección"
              value={[order.deliveryAddress.street, order.deliveryAddress.neighborhood]
                .filter(Boolean)
                .join(", ")}
            />
          )}
          {!entrega && order.pickupPointName && (
            <Field
              label="Dónde"
              value={[order.pickupPointName, order.pickupPointAddress].filter(Boolean).join(" · ")}
            />
          )}
          {order.notes && <Field label="Tu nota" value={order.notes} />}
        </dl>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-2">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-ink-2 uppercase">{label}</dt>
      <dd className="mt-1 break-words text-ink" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
