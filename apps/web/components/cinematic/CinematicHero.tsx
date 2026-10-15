import { getImageProps } from "next/image";
import { formatLocalDate } from "@pdp/domain";
import { hour12 } from "@/lib/format";
import { CinLink } from "./Button";
import { HeroFilmOverlay, HeroFilmVideo } from "./HeroFilm";
import type { HeroFilmSources } from "./heroFilm.config";
import { HERO, HERO_SQUARE } from "./photos";
import { Lines } from "./TextReveal";

export type OpenStatus = { open: boolean; reason?: string; opensAt?: string; closesAt?: string };
export type NextDate = { date: string; orderBy: { date: string; time: string } } | null;

/** Texto corto del estado real del negocio ("Abierto ahora · cerramos a las 6:00 p. m."). */
export function statusDetail(status: OpenStatus): string {
  if (status.open) return status.closesAt ? `cerramos a las ${hour12(status.closesAt)}` : "";
  if (status.opensAt && status.reason?.startsWith("Abrimos"))
    return `abrimos a las ${hour12(status.opensAt)}`;
  if (status.reason === "Cerrado hoy" || status.reason === "Cerrado por hoy")
    return "hoy no abrimos";
  return status.reason ? status.reason.toLowerCase() : "";
}

/**
 * Portada (jerarquía A). Rompe el patrón imagen + texto + botón: fotografía real a sangre, titular enorme
 * por líneas y una barra de datos reales (abierto/cerrado y próxima entrega).
 * Capas y quién las mueve (nunca dos transform en el mismo elemento):
 *   .cin-hero-media [data-depth]  → puntero (lib/motion/hero.ts)
 *   .cin-hero-zoom                → scroll (motion.css)
 *   img.cin-hero-img              → entrada (motion.css)
 * La secuencia y la transición con el scroll viven en app/motion.css; sin JS o con reduced motion
 * la portada se ve completa y quieta.
 * Con `film` (archivos en public/film, ver docs/HERO_FILM.md) la portada suma la película «Del amasado al
 * aroma» controlada por el scroll (lib/motion/heroFilm.ts). Esta portada estática sigue siendo la base: es lo
 * primero que se ve, el respaldo si la película tarda o falla, y lo único con reduced motion o sin JS.
 */
const AFTER_ID = "tras-portada";

export function CinematicHero({
  status,
  next,
  film = {},
}: {
  status: OpenStatus;
  next: NextDate;
  film?: HeroFilmSources;
}) {
  const detail = statusDetail(status);
  const hasFilm = Boolean(film.horizontal || film.vertical);
  // Art direction: foto panorámica desde 640 px y recorte cuadrado de la misma foto en móvil.
  const base = { alt: HERO.alt, fill: true, quality: 60, priority: true } as const;
  const {
    props: { srcSet: wide },
  } = getImageProps({ ...base, src: HERO.src, sizes: "100vw" });
  const { props: square } = getImageProps({
    ...base,
    src: HERO_SQUARE.src,
    sizes: "110vw",
    fetchPriority: "high",
  });
  return (
    <>
      <div
        className="cin-hero-pin"
        data-hero-pin
        {...(hasFilm && {
          "data-hero-film": "",
          "data-film-h": film.horizontal?.src ?? "",
          "data-film-v": film.vertical?.src ?? "",
          "data-film-poster-h": film.horizontal?.poster ?? "",
          "data-film-poster-v": film.vertical?.poster ?? "",
          "data-film-after": AFTER_ID,
        })}
      >
        <section className="cin-hero on-dark" data-hero aria-labelledby="hero-title">
          <div className="cin-hero-media" data-depth="-0.8">
            <div className="cin-hero-zoom">
              <picture>
                <source media="(min-width: 640px)" srcSet={wide} sizes="100vw" />
                <img {...square} alt={HERO.alt} className="cin-hero-img" />
              </picture>
            </div>
            {hasFilm && <HeroFilmVideo />}
          </div>
          <div className="cin-hero-scrim" aria-hidden="true" />
          <div className="cin-hero-veil" aria-hidden="true" />
          <div className="cin-hero-grain" aria-hidden="true" />

          <div className="cin-wrap cin-hero-inner">
            <div className="cin-hero-top">
              <p className="cin-index hero-eyebrow">Boulangerie · Made with love</p>
            </div>

            <div className="cin-hero-titlewrap" data-depth="0.5">
              <div className="cin-hero-scrollout">
                <h1 id="hero-title" className="cin-hero-title">
                  <Lines lines={[{ text: "Pan recién" }, { text: "horneado.", accent: true }]} />
                </h1>
              </div>
            </div>

            <div className="cin-hero-body">
              <p className="cin-hero-copy hero-sub">
                {hasFilm
                  ? "Hecho con tiempo, laminado a mano y preparado por pedido."
                  : "Croissants, kouign-amann, galletas y pan de temporada hechos a mano. Pides en línea, eliges tu fecha y lo horneamos para ti."}
              </p>
              <div className="cin-hero-actions hero-cta">
                <CinLink href="/menu" magnetic testId="cta-menu">
                  {hasFilm ? "Ver menú" : "Ver panes"}
                </CinLink>
                <CinLink href="#como-pedir" variant="text">
                  {hasFilm ? "Cómo comprar" : "Cómo pedir"}
                </CinLink>
              </div>
            </div>

            <div className="cin-hero-meta">
              <p className="cin-hero-status hero-status" data-testid="open-status">
                <span
                  className={status.open ? "cin-dot" : "cin-dot cin-dot-closed"}
                  aria-hidden="true"
                />
                <span>
                  <strong>{status.open ? "Abierto ahora" : "Cerrado"}</strong>
                  {detail && <span> · {detail}</span>}
                </span>
              </p>
              {next && (
                <a href="#fecha" className="hero-status">
                  <span>
                    Próxima entrega: <strong>{formatLocalDate(next.date)}</strong>
                  </span>
                </a>
              )}
              <span className="cin-hero-cue" aria-hidden="true">
                {hasFilm ? "Desliza para descubrir cómo lo hacemos" : "Desliza"}
                <i />
              </span>
            </div>
          </div>

          <p className="cin-hero-after" aria-hidden="true">
            <span>Hecho a mano.</span>
            <span>Horneado para ti.</span>
          </p>
          {hasFilm && <HeroFilmOverlay afterId={AFTER_ID} />}
        </section>
      </div>
      {hasFilm && <span id={AFTER_ID} tabIndex={-1} className="cin-film-after" />}
    </>
  );
}
