import { formatLocalDate } from "@pdp/domain";
import { hour12 } from "@/lib/format";
import { Reveal } from "../Reveal";
import { CinLink } from "./Button";
import type { NextDate } from "./CinematicHero";

/** Cierre del home: tipografía grande y las dos acciones que importan. */
export function CinematicCTA({ next }: { next: NextDate }) {
  return (
    <section className="cin-section" aria-labelledby="cta-title">
      <div className="cin-wrap">
        <Reveal>
          <h2 id="cta-title" className="cin-cta-title">
            Tu próximo pan <span className="accent">ya tiene fecha.</span>
          </h2>
        </Reveal>
        <Reveal className="cin-cta-foot" delay={120}>
          <p className="cin-lead">
            {next ? (
              <>
                Próxima entrega: <strong className="text-ink">{formatLocalDate(next.date)}</strong>.
                Pide antes del {formatLocalDate(next.orderBy.date)} a las{" "}
                {hour12(next.orderBy.time)}
              </>
            ) : (
              "Pide en línea y recoge tu pan en la fecha que elijas."
            )}
          </p>
          <div className="cin-cta-actions">
            <CinLink href="/menu" magnetic>
              Hacer pedido
            </CinLink>
            <CinLink href="/menu" variant="secondary" arrow={false}>
              Ver panes
            </CinLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
