import Link from "next/link";
import { ORDER_STATUS_LABELS, portalTimeline } from "@pdp/domain";
import { AppBanners } from "@/components/portal/AppBanners";
import { LiveOrders } from "@/components/portal/LiveOrders";
import { dateTimeMX, money } from "@/lib/format";
import { listPortalOrders, portalPulse } from "@/lib/portal/orders";
import { requireCustomerSession } from "@/lib/portal/session";
import { env } from "@/lib/env";
import { getBusiness } from "@/lib/site";

export const metadata = { title: "Mis pedidos", robots: { index: false, follow: false } };

export default async function PortalOrdersPage() {
  const session = await requireCustomerSession();
  const [orders, business, pulse] = await Promise.all([
    listPortalOrders(session.customer.id),
    getBusiness(),
    portalPulse(session.customer.id),
  ]);

  return (
    <div className="space-y-5">
      <LiveOrders inicial={pulse} />
      <h1 className="font-display text-2xl text-ink">Mis pedidos</h1>
      {/* Aquí sí tiene sentido ofrecer los avisos: el cliente vino a ver cómo va su pedido. */}
      <AppBanners vapidPublicKey={env().NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null} pedirAvisos />

      {orders.length === 0 ? (
        <section className="card p-6 text-center">
          <p className="text-ink-2">
            Todavía no tienes pedidos. Cuando hagas uno —en línea, por teléfono o en la panadería—
            aparecerá aquí y podrás seguirlo paso a paso.
          </p>
          <Link href="/menu" className="btn btn-sage mt-4">
            Ver el menú
          </Link>
        </section>
      ) : (
        <ul className="space-y-3" data-testid="portal-orders">
          {orders.map((o) => {
            const { cancelled } = portalTimeline(o.status, o.fulfillmentType, []);
            return (
              <li key={o.folio}>
                <Link
                  href={`/portal/pedidos/${o.folio}`}
                  className="card block p-5 transition hover:border-sage/50"
                  data-testid={`portal-order-${o.folio}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-mono text-sm tracking-wide text-ink-2">{o.folio}</p>
                    <p
                      className={`text-sm font-semibold ${cancelled ? "text-ink-2" : "text-sage"}`}
                      data-testid={`portal-order-status-${o.folio}`}
                    >
                      {ORDER_STATUS_LABELS[o.status]}
                    </p>
                  </div>
                  <p className="mt-1 text-sm text-ink-2">
                    {dateTimeMX(o.placedAt, business.timezone)}
                  </p>
                  {o.summary && <p className="mt-2 line-clamp-2 text-ink">{o.summary}</p>}
                  <div className="mt-3 flex items-baseline justify-between gap-4">
                    <span className="text-sm text-ink-2">
                      {o.itemsCount} {o.itemsCount === 1 ? "producto" : "productos"}
                    </span>
                    <span className="font-display text-xl text-ink">{money(o.totalCents)}</span>
                  </div>
                  <span className="mt-3 inline-block text-sm font-medium text-sage underline">
                    Ver seguimiento
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
