import type { Metadata } from "next";
import Link from "next/link";
import { WEEKDAY_LABELS, formatLocalDate } from "@pdp/domain";
import { FULFILLMENT_LABELS, capitalize, hour12, hourRange } from "@/lib/format";
import { fulfillmentOptions, getBusiness, openStatus } from "@/lib/site";

export const metadata: Metadata = {
  title: "Horarios",
  description: "Horario de la panadería, días de pedido y próximas fechas de recolección.",
  alternates: { canonical: "/horarios" },
};

export default async function HoursPage() {
  const business = await getBusiness();
  const status = openStatus(business);
  const options = fulfillmentOptions(business);
  const upcomingExceptions = business.exceptions.filter((e) => e.isClosed || e.noOrders);
  return (
    <div className="container-x max-w-4xl py-10 sm:py-14">
      <p className="eyebrow mb-2">Horarios</p>
      <h1 className="display text-4xl sm:text-5xl">Cuándo encontrarnos</h1>
      <p className="mt-3 inline-flex items-center gap-2 text-ink-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${status.open ? "bg-sage" : "bg-crust"}`} aria-hidden="true" />
        {status.open ? `Abierto ahora${status.closesAt ? ` · cerramos a las ${hour12(status.closesAt)}` : ""}` : `Cerrado${status.reason ? ` · ${status.reason.toLowerCase()}` : ""}`}
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <section className="card p-6" aria-labelledby="h-tienda">
          <h2 id="h-tienda" className="font-display text-2xl text-ink">
            Panadería
          </h2>
          <ul className="mt-4 divide-y divide-line text-sm">
            {business.hours.map((h) => (
              <li key={h.weekday} className="flex justify-between py-2">
                <span>{WEEKDAY_LABELS[h.weekday]}</span>
                <span className={`tabular-nums ${h.isOpen ? "text-ink" : "text-ink-2"}`}>{h.isOpen && h.opensAt && h.closesAt ? hourRange(h.opensAt, h.closesAt) : "Cerrado"}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-6" aria-labelledby="h-pedidos">
          <h2 id="h-pedidos" className="font-display text-2xl text-ink">
            Pedidos en línea
          </h2>
          {business.windows.length === 0 ? (
            <p className="mt-3 text-sm text-ink-2">Por ahora no hay ventanas de pedido activas.</p>
          ) : (
            <ul className="mt-4 space-y-4 text-sm">
              {business.windows.map((w) => (
                <li key={w.id}>
                  <p className="font-medium text-ink">{w.name}</p>
                  <p className="text-ink-2">
                    Pedidos {w.orderWeekdays.map((d) => WEEKDAY_LABELS[d]).join(", ")} hasta las {hour12(w.cutoffTime)}.
                  </p>
                  <p className="text-ink-2">
                    {FULFILLMENT_LABELS[w.fulfillmentType]}: {WEEKDAY_LABELS[w.fulfillmentWeekday]}
                    {(w.fulfillmentFrom || w.fulfillmentTo) && ` de ${hourRange(w.fulfillmentFrom, w.fulfillmentTo)}`}.
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="mt-8" aria-labelledby="h-fechas">
        <h2 id="h-fechas" className="display text-3xl">
          Próximas fechas
        </h2>
        {options.length === 0 ? (
          <p className="mt-3 text-ink-2">No hay fechas abiertas en este momento.</p>
        ) : (
          <ul className="mt-4 grid gap-4 md:grid-cols-2">
            {options.map((o) => (
              <li key={`${o.windowId}-${o.date}`} className="card p-5">
                <p className="eyebrow">{FULFILLMENT_LABELS[o.fulfillmentType] ?? o.windowName}</p>
                <p className="font-display text-2xl text-ink">{capitalize(formatLocalDate(o.date))}</p>
                {(o.from || o.to) && <p className="text-sm text-ink-2">{hourRange(o.from, o.to)}</p>}
                <p className="mt-1 text-sm text-ink-2">
                  Pide antes del {formatLocalDate(o.orderBy.date)} a las {hour12(o.orderBy.time)}.
                </p>
              </li>
            ))}
          </ul>
        )}
        <Link href="/menu" className="btn btn-primary mt-6">
          Hacer un pedido
        </Link>
      </section>

      {upcomingExceptions.length > 0 && (
        <section className="mt-8" aria-labelledby="h-excepciones">
          <h2 id="h-excepciones" className="display text-3xl">
            Días especiales
          </h2>
          <ul className="mt-4 space-y-2 text-sm">
            {upcomingExceptions.map((e) => (
              <li key={e.date} className="card flex justify-between gap-3 px-4 py-3">
                <span className="text-ink">{capitalize(formatLocalDate(e.date))}</span>
                <span className="text-ink-2">{e.note ?? (e.isClosed ? "Cerrado" : "Sin pedidos")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
