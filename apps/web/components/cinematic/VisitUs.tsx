import Link from "next/link";
import { WEEKDAY_LABELS, type BusinessHour } from "@pdp/domain";
import { hourRange } from "@/lib/format";
import { instagramUrl, type PickupPoint } from "@/lib/site";
import { Reveal } from "../Reveal";
import { Arrow } from "./Button";
import { statusDetail, type OpenStatus } from "./CinematicHero";

/**
 * Estado abierto/cerrado (dato real de `isOpenNow`), horario semanal con el día de hoy marcado y punto de
 * recolección. Elegante y quieto: el punto de estado no pulsa.
 */
export function VisitUs({
  status,
  hours,
  today,
  point,
  address,
  instagram,
}: {
  status: OpenStatus;
  hours: BusinessHour[];
  today: number;
  point: PickupPoint | undefined;
  address: string | null;
  instagram: string | null;
}) {
  const detail = statusDetail(status);
  const igUrl = instagramUrl(instagram);
  const hasHours = hours.some((h) => h.isOpen && h.opensAt && h.closesAt);
  const placeAddress =
    point?.address && point.address !== "Dirección por configurar"
      ? point.address
      : (address ?? "Te compartimos la dirección exacta al confirmar tu pedido.");
  return (
    <section id="visitanos" className="cin-section" aria-labelledby="visitanos-title">
      <div className="cin-wrap cin-visit-grid">
        <Reveal>
          <h2 id="visitanos-title" className="cin-index">
            <span className="cin-index-num">08</span> Horarios y ubicación
          </h2>
          <p className="cin-open mt-6">
            <span
              className={status.open ? "cin-dot" : "cin-dot cin-dot-closed"}
              aria-hidden="true"
            />
            <span>{status.open ? "Abierto ahora" : "Cerrado ahora"}</span>
          </p>
          {detail && (
            <p className="cin-open-note">{detail.charAt(0).toUpperCase() + detail.slice(1)}.</p>
          )}

          <div className="cin-place">
            <h3 className="cin-place-name">{point?.name ?? "Punto de recolección"}</h3>
            <p className="mt-2 text-ink-2">{placeAddress}</p>
            {point?.notes && <p className="mt-2 text-sm text-ink-2">{point.notes}</p>}
            <div className="cin-place-actions">
              <Link href="/ubicacion" className="cin-btn cin-btn-secondary">
                <span>Cómo llegar</span>
                <Arrow />
              </Link>
              {igUrl && (
                <a href={igUrl} target="_blank" rel="noopener noreferrer" className="cin-link">
                  <span>Instagram @{instagram}</span>
                  <Arrow />
                </a>
              )}
            </div>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <h3 className="font-display text-2xl text-ink">Horario de la panadería</h3>
          {hasHours ? (
            <ul className="cin-hours mt-5">
              {hours.map((h) => (
                <li key={h.weekday} className={h.weekday === today ? "is-today" : undefined}>
                  <span>
                    {WEEKDAY_LABELS[h.weekday]}
                    {h.weekday === today && <span className="cin-today">Hoy</span>}
                  </span>
                  <span className={`tabular-nums ${h.isOpen ? "text-ink" : "text-ink-2"}`}>
                    {h.isOpen && h.opensAt && h.closesAt
                      ? hourRange(h.opensAt, h.closesAt)
                      : "Cerrado"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-ink-2">Horarios por confirmar.</p>
          )}
          <Link href="/horarios" className="cin-link mt-4">
            <span>Ver días especiales y fechas de entrega</span>
            <Arrow />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}
