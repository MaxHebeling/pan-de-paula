import Link from "next/link";
import { hour12 } from "@/lib/format";
import { Logo } from "./Logo";

type OpenStatus = { open: boolean; reason?: string; opensAt?: string; closesAt?: string };

/**
 * Hero (jerarquía A). Entrada cinematográfica en CSS puro (app/motion.css): marca → titular → subtítulo →
 * CTA → estado → arte, ≈1.3 s sin bloquear nada. El h1 (LCP) solo se desplaza, nunca parte de opacity 0.
 * Las capas [data-depth] siguen el puntero unos píxeles en desktop (lib/motion/hero.ts).
 */
export function Hero({ status }: { status: OpenStatus }) {
  return (
    <section className="relative overflow-hidden" data-hero>
      <div className="container-x grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="eyebrow hero-eyebrow mb-4">Boulangerie · Made with love</p>
          <h1 className="display text-4xl leading-[1.05] sm:text-5xl lg:text-6xl">
            <span className="hero-line">Pan recién horneado,</span>
            <span className="hero-line">
              <span className="text-sage">hecho a mano</span> para tu mesa.
            </span>
          </h1>
          <p className="hero-sub mt-5 max-w-xl text-lg text-ink-2">
            Croissants de mantequilla, roles de canela y galletas que salen del horno el mismo día
            que los recoges. Pide en línea; nosotros horneamos para tu fecha.
          </p>
          <div className="hero-cta mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="btn btn-primary btn-lg"
              data-testid="cta-menu"
              data-magnetic
            >
              Ver menú
              <svg
                className="btn-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
            <Link href="/menu" className="btn btn-secondary btn-lg" data-magnetic>
              Pedir ahora
            </Link>
          </div>
          <p
            className="hero-status mt-6 inline-flex items-center gap-2.5 rounded-pill border border-line bg-paper/80 px-4 py-2 text-sm"
            data-testid="open-status"
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${status.open ? "status-dot bg-sage" : "status-dot-closed bg-crust"}`}
              aria-hidden="true"
            />
            {status.open ? (
              <span>
                <strong className="font-semibold">Abierto ahora</strong>
                {status.closesAt && (
                  <span className="text-ink-2"> · cerramos a las {hour12(status.closesAt)}</span>
                )}
              </span>
            ) : (
              <span>
                <strong className="font-semibold">Cerrado</strong>
                <span className="text-ink-2">
                  {" "}
                  ·{" "}
                  {status.opensAt && status.reason?.startsWith("Abrimos")
                    ? `abrimos a las ${hour12(status.opensAt)}`
                    : status.reason?.toLowerCase()}
                </span>
              </span>
            )}
          </p>
        </div>

        <div className="hero-art-enter relative mx-auto w-full max-w-[240px] sm:max-w-sm lg:max-w-md">
          <div
            className="absolute -inset-6 rounded-full bg-crust/15 blur-2xl"
            data-depth="-0.6"
            aria-hidden="true"
          />
          <div data-depth="1" className="relative">
            <div className="card relative aspect-square overflow-hidden rounded-full p-6">
              <Logo size={480} priority className="h-full w-full" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
