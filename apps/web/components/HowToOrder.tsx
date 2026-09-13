import type { CSSProperties } from "react";
import { SplitWords } from "@/lib/motion/textReveal";
import { Reveal } from "./Reveal";

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
    body: "Paga en línea, al recoger o por transferencia. Te avisamos cuando esté listo.",
  },
];

/**
 * "Cómo pedir": tres pasos que se encienden en secuencia mientras una línea se dibuja 01 → 02 → 03
 * (SVG con stroke-dashoffset en desktop; línea vertical con scaleY en móvil). Sin JS: todo dibujado y visible.
 */
export function HowToOrder() {
  return (
    <section
      id="como-pedir"
      className="bg-cream-2/50 py-12 sm:py-16"
      aria-labelledby="como-pedir-title"
    >
      <div className="container-x">
        <Reveal className="mb-10 max-w-2xl">
          <p className="eyebrow mb-2">Así de fácil</p>
          <h2 id="como-pedir-title" className="display text-3xl sm:text-4xl">
            <SplitWords text="Cómo pedir" />
          </h2>
        </Reveal>

        <Reveal as="div" variant="none" className="relative" data-testid="how-to-order">
          {/* Línea horizontal (desktop): une los centros de los tres números */}
          <svg
            className="pointer-events-none absolute top-6 right-0 left-0 hidden h-1 w-full md:block"
            viewBox="0 0 300 4"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M50 2H250" stroke="var(--color-line)" strokeWidth="2" pathLength={1} />
            <path
              className="steps-line"
              d="M50 2H250"
              stroke="var(--color-sage)"
              strokeWidth="2"
              strokeLinecap="round"
              pathLength={1}
            />
          </svg>
          {/* Línea vertical (móvil) */}
          <span
            className="absolute top-8 bottom-8 left-6 w-px bg-line md:hidden"
            aria-hidden="true"
          />
          <span
            className="steps-vline absolute top-8 bottom-8 left-6 w-px bg-sage md:hidden"
            aria-hidden="true"
          />

          <ol className="relative grid gap-8 md:grid-cols-3 md:gap-6">
            {STEPS.map((s, i) => (
              <li
                key={s.number}
                className="flex gap-5 md:flex-col md:items-center md:text-center"
                style={{ "--i": i } as CSSProperties}
              >
                <span
                  className="step-num relative z-10 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sage font-display text-base text-white shadow-soft ring-4 ring-cream-2"
                  aria-hidden="true"
                >
                  {s.number}
                </span>
                <div className="card flex-1 p-5 md:mt-2 md:w-full md:p-6">
                  <h3 className="font-display text-xl text-ink">
                    <span className="sr-only">Paso {i + 1}: </span>
                    {s.title}
                  </h3>
                  <p className="mt-2 text-sm text-ink-2">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </div>
    </section>
  );
}
