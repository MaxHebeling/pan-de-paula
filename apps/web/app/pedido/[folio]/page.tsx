import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ORDER_STATUS_LABELS, type OrderStatus } from "@pdp/domain";
import { FULFILLMENT_LABELS, dateMX, dateTimeMX, hourRange, money } from "@/lib/format";
import { getOrderByFolio, mercadoPagoAvailable } from "@/lib/orders";
import { getBusiness, instagramUrl, whatsappLink } from "@/lib/site";
import { retryPaymentAction } from "./actions";

type Props = {
  params: Promise<{ folio: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Tu pedido", robots: { index: false, follow: false } };

const STEP_ORDER: OrderStatus[] = [
  "new",
  "confirmed",
  "payment_pending",
  "paid",
  "in_production",
  "ready",
  "ready_for_pickup",
  "out_for_delivery",
  "delivered",
  "completed",
];

function TimelineStep({
  label,
  at,
  done,
  current,
  tz,
}: {
  label: string;
  at?: Date | null;
  done: boolean;
  current: boolean;
  tz: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex flex-col items-center">
        <span
          className={`mt-1 inline-block h-3.5 w-3.5 rounded-full border-2 ${current ? "border-sage bg-sage" : done ? "border-sage bg-sage/40" : "border-line bg-paper"}`}
          aria-hidden="true"
        />
        <span className="w-px flex-1 bg-line" aria-hidden="true" />
      </span>
      <span className="pb-4">
        <span
          className={`block text-sm ${current ? "font-semibold text-ink" : done ? "text-ink" : "text-ink-2"}`}
        >
          {label}
        </span>
        {at && <span className="block text-xs text-ink-2">{dateTimeMX(at, tz)}</span>}
      </span>
    </li>
  );
}

export default async function OrderPage({ params, searchParams }: Props) {
  const { folio } = await params;
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : null;
  const order = await getOrderByFolio(decodeURIComponent(folio), token);
  if (!order) notFound();
  const business = await getBusiness();
  const mp = typeof sp.mp === "string" ? sp.mp : null;
  const isNew = sp.nuevo === "1";
  const wa = whatsappLink(business, `Hola, tengo una duda sobre mi pedido ${order.folio}`);
  const ig = instagramUrl(business.instagramHandle);
  const mpAvailable = mercadoPagoAvailable(business.flags);
  const payable =
    ["new", "payment_pending"].includes(order.status) &&
    ["pending", "failed"].includes(order.paymentStatus);
  const cancelled = order.status === "cancelled" || order.status === "refunded";

  const reached = new Set(order.history.map((h) => h.toStatus));
  const timelineKeys: OrderStatus[] = (() => {
    const base: OrderStatus[] = ["new", "confirmed"];
    if (order.paymentMethod === "mercadopago") base.push("paid");
    base.push("in_production");
    base.push(order.fulfillmentType === "delivery" ? "out_for_delivery" : "ready_for_pickup");
    base.push("delivered");
    for (const h of order.history)
      if (!base.includes(h.toStatus) && !["cancelled", "refunded"].includes(h.toStatus))
        base.push(h.toStatus);
    return base.sort((a, b) => STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b));
  })();
  const currentIdx = Math.max(...timelineKeys.map((k, i) => (reached.has(k) ? i : -1)));

  const banner = (() => {
    if (mp === "success")
      return {
        tone: "sage",
        text: "Mercado Pago confirmó tu pago. En unos momentos verás tu pedido como pagado.",
      };
    if (mp === "pending")
      return {
        tone: "crust",
        text: "Tu pago está en proceso. Te avisaremos en cuanto Mercado Pago lo confirme.",
      };
    if (mp === "failure")
      return {
        tone: "wine",
        text: "El pago no se completó. Puedes intentarlo de nuevo o escribirnos para pagar de otra forma.",
      };
    if (mp === "error")
      return {
        tone: "wine",
        text: "No pudimos iniciar el pago en línea. Tu pedido quedó registrado; intenta de nuevo o escríbenos.",
      };
    if (mp === "ratelimit")
      return { tone: "wine", text: "Demasiados intentos de pago. Espera unos minutos." };
    if (isNew)
      return {
        tone: "sage",
        text: "¡Recibimos tu pedido! Guarda esta página: es tu comprobante y aquí verás el avance.",
      };
    return null;
  })();

  return (
    <div className="container-x max-w-4xl py-10 sm:py-14">
      <p className="eyebrow">Pedido</p>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="display text-4xl" data-testid="order-folio">
          {order.folio}
        </h1>
        <span
          className={`badge ${cancelled ? "bg-ink text-cream" : order.paymentStatus === "paid" ? "bg-sage text-white" : "bg-crust text-ink"}`}
          data-testid="order-status"
        >
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        Realizado el {dateTimeMX(order.placedAt, business.timezone)}
      </p>

      {banner && (
        <p
          className={`mt-6 rounded-card border px-4 py-3 text-sm ${banner.tone === "sage" ? "border-sage/40 bg-sage/10 text-ink" : banner.tone === "wine" ? "border-wine/40 bg-wine/10 text-ink" : "border-crust/50 bg-crust/10 text-ink"}`}
          role="status"
        >
          {banner.text}
        </p>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="card p-5 sm:p-6">
            <h2 className="font-display text-xl text-ink">
              {FULFILLMENT_LABELS[order.fulfillmentType] ?? "Entrega"}
            </h2>
            {order.scheduledFor && (
              <p className="mt-2 text-lg text-ink" data-testid="order-date">
                {dateMX(order.scheduledFor, business.timezone)}
                {(order.windowFrom || order.windowTo) && (
                  <span className="text-ink-2">
                    {" "}
                    · {hourRange(order.windowFrom, order.windowTo)}
                  </span>
                )}
              </p>
            )}
            {order.pickupPoint && (
              <p className="mt-2 text-sm text-ink-2">
                <strong className="text-ink">{order.pickupPoint.name}</strong>
                {order.pickupPoint.address &&
                order.pickupPoint.address !== "Dirección por configurar"
                  ? ` · ${order.pickupPoint.address}`
                  : ""}
                {order.pickupPoint.mapUrl && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={order.pickupPoint.mapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sage underline"
                    >
                      Cómo llegar
                    </a>
                  </>
                )}
              </p>
            )}
            {order.deliveryAddress?.street && (
              <p className="mt-2 text-sm text-ink-2">
                Entrega en <strong className="text-ink">{order.deliveryAddress.street}</strong>
                {order.deliveryAddress.neighborhood
                  ? `, ${order.deliveryAddress.neighborhood}`
                  : ""}
                {order.deliveryAddress.references_note
                  ? ` (${order.deliveryAddress.references_note})`
                  : ""}
              </p>
            )}
            {order.notes && (
              <p className="mt-3 rounded-[12px] bg-cream px-3 py-2 text-sm text-ink-2">
                Notas: {order.notes}
              </p>
            )}
          </section>

          <section className="card p-5 sm:p-6">
            <h2 className="font-display text-xl text-ink">Tu pan</h2>
            <ul className="mt-3 divide-y divide-line">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span>
                    <span className="font-medium text-ink">{i.qty} ×</span> {i.name}
                    {i.variantLabel && <span className="text-ink-2"> · {i.variantLabel}</span>}
                  </span>
                  <span className="tabular-nums">{money(i.totalCents)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-2">Subtotal</dt>
                <dd className="tabular-nums">{money(order.subtotalCents)}</dd>
              </div>
              {order.discountCents > 0 && (
                <div className="flex justify-between text-sage">
                  <dt>Descuento{order.couponCode ? ` (${order.couponCode})` : ""}</dt>
                  <dd className="tabular-nums">−{money(order.discountCents)}</dd>
                </div>
              )}
              {order.deliveryFeeCents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-ink-2">Envío</dt>
                  <dd className="tabular-nums">{money(order.deliveryFeeCents)}</dd>
                </div>
              )}
              {order.taxCents > 0 && (
                <div className="flex justify-between">
                  <dt className="text-ink-2">IVA</dt>
                  <dd className="tabular-nums">{money(order.taxCents)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-line pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums" data-testid="order-total">
                  {money(order.totalCents)}
                </dd>
              </div>
              {order.paidCents > 0 && order.paidCents < order.totalCents && (
                <div className="flex justify-between text-ink-2">
                  <dt>Pagado</dt>
                  <dd className="tabular-nums">{money(order.paidCents)}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="card p-5 sm:p-6">
            <h2 className="font-display text-xl text-ink">Pago</h2>
            {order.paymentStatus === "paid" ? (
              <p className="mt-2 text-sm text-ink">Pagado. ¡Gracias!</p>
            ) : cancelled ? (
              <p className="mt-2 text-sm text-ink-2">
                Este pedido fue {ORDER_STATUS_LABELS[order.status].toLowerCase()}.
              </p>
            ) : order.paymentMethod === "cash" ? (
              <p className="mt-2 text-sm text-ink" data-testid="payment-cash">
                Pagas <strong>{money(order.totalCents)}</strong> al recoger tu pedido, en efectivo o
                con tarjeta en el mostrador.
              </p>
            ) : order.paymentMethod === "transfer" ? (
              <div className="mt-2 text-sm text-ink">
                <p>
                  Transfiere <strong>{money(order.totalCents)}</strong> y usa el folio{" "}
                  <strong>{order.folio}</strong> como concepto.
                </p>
                {business.policies.transfer_instructions && (
                  <pre className="mt-3 rounded-[12px] bg-cream px-4 py-3 font-body text-sm whitespace-pre-wrap text-ink">
                    {business.policies.transfer_instructions}
                  </pre>
                )}
                <p className="mt-2 text-ink-2">
                  Cuando la recibamos, lo marcamos como pagado aquí.
                </p>
              </div>
            ) : (
              <div className="mt-2 text-sm text-ink">
                <p>
                  Pago en línea con Mercado Pago{" "}
                  {order.paymentStatus === "failed"
                    ? "— el último intento no se completó."
                    : "— pendiente."}
                </p>
                {payable && mpAvailable && (
                  <form action={retryPaymentAction} className="mt-3">
                    <input type="hidden" name="folio" value={order.folio} />
                    <input type="hidden" name="t" value={order.publicToken} />
                    <button type="submit" className="btn btn-primary">
                      {order.paymentStatus === "failed" ? "Reintentar pago" : "Pagar ahora"}
                    </button>
                  </form>
                )}
                {payable && !mpAvailable && (
                  <p className="mt-2 text-ink-2">
                    El pago en línea no está disponible en este momento; escríbenos para acordar
                    otra forma de pago.
                  </p>
                )}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card p-5">
            <h2 className="font-display text-xl text-ink">Seguimiento</h2>
            {cancelled ? (
              <p className="mt-3 text-sm text-ink-2">
                Pedido {ORDER_STATUS_LABELS[order.status].toLowerCase()}.
              </p>
            ) : (
              <ol className="mt-4">
                {timelineKeys.map((k, i) => {
                  const h = order.history.find((x) => x.toStatus === k);
                  return (
                    <TimelineStep
                      key={k}
                      label={k === "new" ? "Recibido" : ORDER_STATUS_LABELS[k]}
                      at={h?.at ?? null}
                      done={i <= currentIdx}
                      current={i === currentIdx}
                      tz={business.timezone}
                    />
                  );
                })}
              </ol>
            )}
          </section>
          <section className="card p-5">
            <h2 className="font-display text-xl text-ink">¿Necesitas ayuda?</h2>
            <p className="mt-2 text-sm text-ink-2">Escríbenos y menciona tu folio.</p>
            <div className="mt-3 flex flex-col gap-2">
              {wa && (
                <a href={wa} target="_blank" rel="noopener noreferrer" className="btn btn-sage">
                  WhatsApp
                </a>
              )}
              {ig && (
                <a
                  href={ig}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary"
                >
                  Instagram
                </a>
              )}
              <Link href="/menu" className="btn btn-ghost">
                Seguir comprando
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
