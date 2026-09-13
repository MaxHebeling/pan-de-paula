import type { CSSProperties } from "react";
import { Reveal } from "../Reveal";
import { SectionHeading } from "./SectionHeading";

const STEPS = [
  {
    number: "01",
    title: "Elige tu pan",
    body: "Arma tu pedido desde el menú: croissants, roles, galletas y más.",
  },
  {
    number: "02",
    title: "Escoge tu fecha",
    body: "Te mostramos las próximas fechas disponibles para recoger. Horneamos ese día.",
  },
  {
    number: "03",
    title: "Recoge y disfruta",
    body: "",
  },
];

/**
 * "Cómo pedir": 01 — 02 — 03 unidos por una línea que se dibuja con el scroll (scroll-driven animations;
 * sin soporte, al revelarse con IntersectionObserver). Sin JS o con reduced motion: línea completa y todo visible.
 * `payment` describe los métodos que el checkout ofrece hoy (se arma en app/page.tsx con los flags reales).
 */
export function Timeline({ payment }: { payment: string }) {
  return (
    <section id="como-pedir" className="cin-section cin-tint" aria-labelledby="como-pedir-title">
      <div className="cin-wrap">
        <SectionHeading
          id="como-pedir-title"
          index="06"
          eyebrow="Así de fácil"
          title="Cómo pedir"
          intro="Tres pasos y listo. Sin cuentas ni contraseñas."
        />
        <Reveal as="div" variant="none" className="cin-timeline" data-testid="how-to-order">
          <span className="cin-timeline-track" aria-hidden="true" />
          <span className="cin-timeline-fill" aria-hidden="true" />
          <ol className="cin-timeline-steps">
            {STEPS.map((s, i) => (
              <li
                key={s.number}
                className="cin-timeline-step"
                style={{ "--i": i } as CSSProperties}
              >
                <span className="cin-timeline-num" aria-hidden="true">
                  {s.number}
                </span>
                <h3 className="cin-timeline-title">
                  <span className="sr-only">Paso {i + 1}: </span>
                  {s.title}
                </h3>
                <p className="cin-timeline-body">
                  {i === STEPS.length - 1 ? `${payment} Te avisamos cuando esté listo.` : s.body}
                </p>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}
