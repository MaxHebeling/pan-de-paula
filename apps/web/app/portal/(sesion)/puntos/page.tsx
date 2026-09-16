import Link from "next/link";
import { notFound } from "next/navigation";
import { dateTimeMX } from "@/lib/format";
import { getProgram, loyaltyEnabled } from "@/lib/loyalty";
import {
  getPortalCustomer,
  listPortalPointsMovements,
  POINTS_KIND_LABELS,
} from "@/lib/portal/data";
import { requireCustomerSession } from "@/lib/portal/session";
import { getBusiness } from "@/lib/site";

export const metadata = { title: "Mis puntos", robots: { index: false, follow: false } };

export default async function PortalPointsPage() {
  const session = await requireCustomerSession();
  const [customer, business, program] = await Promise.all([
    getPortalCustomer(session.customer.id),
    getBusiness(),
    getProgram(),
  ]);
  if (!customer) notFound();
  const movements = await listPortalPointsMovements(customer.id);
  const enabled = loyaltyEnabled(business.flags, program);

  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-6">
        <h1 className="font-display text-2xl text-ink">Mis puntos</h1>
        <p className="mt-4 text-sm text-ink-2">Saldo actual</p>
        <p className="font-display text-5xl leading-none text-ink" data-testid="portal-saldo">
          {customer.pointsBalance}
        </p>
        <p className="mt-2 text-sm text-ink-2">
          {customer.lifetimePoints} puntos acumulados desde que te uniste.
        </p>
        {enabled && (
          <p className="mt-3 text-sm text-ink-2">
            Ganas {program.pointsPerUnit} {program.pointsPerUnit === 1 ? "punto" : "puntos"} por
            cada ${(program.unitCents / 100).toFixed(0)} de compra. Los canjes se hacen en la
            panadería mostrando tu QR.
          </p>
        )}
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">Movimientos</h2>
        {movements.length === 0 ? (
          <p className="mt-3 text-sm text-ink-2" data-testid="portal-sin-movimientos">
            Todavía no tienes movimientos. En tu próxima compra con la tarjeta empiezan a sumar.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line" data-testid="portal-movimientos">
            {movements.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    {POINTS_KIND_LABELS[m.kind] ?? "Movimiento de puntos"}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-2">
                    {dateTimeMX(m.createdAt, business.timezone)}
                    {m.folio && (
                      <>
                        {" · "}
                        <Link href={`/portal/compras/${m.folio}`} className="underline">
                          {m.folio}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`font-semibold tabular-nums ${m.points >= 0 ? "text-sage" : "text-wine"}`}
                  >
                    {m.points >= 0 ? `+${m.points}` : m.points}
                  </p>
                  <p className="text-xs text-ink-2 tabular-nums">saldo {m.balanceAfter}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
