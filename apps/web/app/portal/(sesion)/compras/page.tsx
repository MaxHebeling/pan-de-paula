import Link from "next/link";
import { dateTimeMX, money } from "@/lib/format";
import { listPortalPurchases, PURCHASE_CHANNEL_LABELS } from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";

export const metadata = { title: "Mis compras", robots: { index: false, follow: false } };

export default async function PortalPurchasesPage() {
  const session = await requireCustomerSession();
  const [business, purchases] = await Promise.all([
    getBusiness(),
    listPortalPurchases(session.customer.id),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Mis compras</h1>
        <p className="mt-1 text-sm text-ink-2">
          Todo lo que compraste identificándote con tu tarjeta, en la panadería o en línea.
        </p>
      </div>

      {purchases.length === 0 ? (
        <section className="card p-6 text-center" data-testid="portal-sin-compras">
          <p className="font-display text-xl text-ink">Todavía no hay compras aquí</p>
          <p className="mt-2 text-sm text-ink-2">
            Muestra tu QR al pagar y cada compra aparecerá en esta lista con sus puntos.
          </p>
          <Link href="/menu" className="btn btn-primary mt-5">
            Ver el menú
          </Link>
        </section>
      ) : (
        <ul className="space-y-3" data-testid="portal-compras">
          {purchases.map((p) => (
            <li key={p.folio}>
              <Link
                href={`/portal/compras/${p.folio}`}
                className="card lift block p-4 sm:p-5"
                data-testid={`portal-compra-${p.folio}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    <p className="text-ink">{dateTimeMX(p.soldAt, business.timezone)}</p>
                    <p className="mt-0.5 truncate text-sm text-ink-2">
                      {p.summary || `${p.itemsCount} artículos`}
                    </p>
                  </div>
                  <p className="shrink-0 font-display text-xl text-ink tabular-nums">
                    {money(p.totalCents)}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-pill bg-cream-2 px-2.5 py-1 text-ink-2">
                    {PURCHASE_CHANNEL_LABELS[p.channel] ?? "Compra"}
                  </span>
                  {p.voided ? (
                    <span className="rounded-pill bg-wine/10 px-2.5 py-1 font-semibold text-wine">
                      Compra cancelada
                    </span>
                  ) : p.pointsEarned > 0 ? (
                    <span className="rounded-pill bg-sage/10 px-2.5 py-1 font-semibold text-sage">
                      +{p.pointsEarned} puntos
                    </span>
                  ) : null}
                  <span className="ml-auto font-mono text-ink-2">{p.folio}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
