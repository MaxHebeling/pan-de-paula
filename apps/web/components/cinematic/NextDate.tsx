import { formatLocalDate, type FulfillmentOption } from "@pdp/domain";
import { FULFILLMENT_LABELS, capitalize, hour12, hourRange } from "@/lib/format";
import { Reveal } from "../Reveal";
import { CinLink } from "./Button";

/**
 * Próxima fecha de entrega. Claridad total: fecha, horario, cierre de pedidos y CTA. Sin efectos:
 * solo el revelado general de sección. Cada fecha lleva data-testid="fulfillment-option".
 */
export function NextDate({ options }: { options: FulfillmentOption[] }) {
  const [first, ...rest] = options;
  return (
    <section id="fecha" className="cin-section cin-paper" aria-labelledby="fecha-title">
      <div className="cin-wrap">
        {first ? (
          <div className="cin-date-grid">
            <Reveal data-testid="fulfillment-option">
              <div className="cin-date-kicker">
                <h2 id="fecha-title" className="cin-index">
                  <span className="cin-index-num">07</span> Próxima fecha de entrega
                </h2>
              </div>
              <p className="cin-date-big">{capitalize(formatLocalDate(first.date))}</p>
              <div className="cin-date-actions">
                <CinLink href="/menu" magnetic>
                  Hacer pedido para esta fecha
                </CinLink>
              </div>
            </Reveal>
            <Reveal delay={100}>
              <dl className="cin-date-facts">
                <div className="cin-date-row">
                  <dt>Modalidad</dt>
                  <dd>{FULFILLMENT_LABELS[first.fulfillmentType] ?? first.windowName}</dd>
                </div>
                {(first.from || first.to) && (
                  <div className="cin-date-row">
                    <dt>Horario</dt>
                    <dd>{hourRange(first.from, first.to)}</dd>
                  </div>
                )}
                <div className="cin-date-row">
                  <dt>Pide antes del</dt>
                  <dd>
                    <strong>{formatLocalDate(first.orderBy.date)}</strong> a las{" "}
                    <strong>{hour12(first.orderBy.time)}</strong>
                  </dd>
                </div>
              </dl>
              {rest.length > 0 && (
                <ul className="cin-date-others" aria-label="Otras fechas disponibles">
                  {rest.map((o) => (
                    <li
                      key={`${o.windowId}-${o.date}`}
                      className="cin-date-other"
                      data-testid="fulfillment-option"
                    >
                      <span className="font-display text-xl text-ink">
                        {capitalize(formatLocalDate(o.date))}
                      </span>
                      <span className="text-sm text-ink-2">
                        {(o.from || o.to) && <>{hourRange(o.from, o.to)} · </>}
                        pide antes del {formatLocalDate(o.orderBy.date)}, {hour12(o.orderBy.time)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Reveal>
          </div>
        ) : (
          <Reveal className="max-w-3xl">
            <h2 id="fecha-title" className="cin-index">
              <span className="cin-index-num">07</span> Próxima fecha de entrega
            </h2>
            <p className="mt-5 font-display text-3xl text-ink sm:text-4xl">
              Por ahora no tenemos fechas abiertas para pedidos en línea.
            </p>
            <p className="cin-lead mt-4">
              Escríbenos por Instagram o WhatsApp y con gusto te ayudamos.
            </p>
          </Reveal>
        )}
      </div>
    </section>
  );
}
