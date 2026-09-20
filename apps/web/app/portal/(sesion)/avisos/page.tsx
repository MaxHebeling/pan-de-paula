import Link from "next/link";
import { LiveOrders } from "@/components/portal/LiveOrders";
import { dateTimeMX } from "@/lib/format";
import { listPortalNotifications, portalPulse } from "@/lib/portal/orders";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";
import { marcarAvisosLeidosAction } from "../actions";

export const metadata = { title: "Avisos", robots: { index: false, follow: false } };

export default async function PortalNotificationsPage() {
  const session = await requireCustomerSession();
  const [avisos, business, pulse] = await Promise.all([
    listPortalNotifications(session.customer.id),
    getBusiness(),
    portalPulse(session.customer.id),
  ]);
  const sinLeer = avisos.filter((a) => !a.read).length;

  return (
    <div className="space-y-5">
      <LiveOrders inicial={pulse} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl text-ink">Avisos</h1>
        {sinLeer > 0 && (
          <form action={marcarAvisosLeidosAction}>
            <button type="submit" className="btn btn-secondary" data-testid="avisos-marcar">
              Marcar todo como leído
            </button>
          </form>
        )}
      </div>

      {avisos.length === 0 ? (
        <section className="card p-6 text-center text-ink-2">
          Aquí te avisaremos cuando tu pedido avance: cuando lo confirmemos, cuando entre al horno y
          cuando esté listo.
        </section>
      ) : (
        <ul className="space-y-3" data-testid="portal-avisos">
          {avisos.map((a) => {
            const cuerpo = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-ink">{a.title}</p>
                  {!a.read && (
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-sage"
                      aria-label="Sin leer"
                    />
                  )}
                </div>
                {a.body && <p className="mt-1 text-sm text-ink-2">{a.body}</p>}
                <p className="mt-2 text-xs text-ink-2">{dateTimeMX(a.at, business.timezone)}</p>
              </>
            );
            return (
              <li key={a.id}>
                {a.folio ? (
                  <Link
                    href={`/portal/pedidos/${a.folio}`}
                    className={`card block p-4 transition hover:border-sage/50 ${a.read ? "" : "border-sage/40"}`}
                    data-testid={`aviso-${a.kind}`}
                  >
                    {cuerpo}
                  </Link>
                ) : (
                  <div className="card p-4" data-testid={`aviso-${a.kind}`}>
                    {cuerpo}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
