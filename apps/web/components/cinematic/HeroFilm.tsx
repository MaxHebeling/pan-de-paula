import Image from "next/image";
import Link from "next/link";
import { CinLink } from "./Button";
import { HERO_FILM } from "./heroFilm.config";

/**
 * Capas de la película de la portada (docs/HERO_FILM.md). Solo presentación: el control vive en
 * lib/motion/heroFilm.ts. Todo empieza oculto y solo se ve con `[data-film="ready"]`; mientras tanto, y si la
 * película falla, la portada estática de CinematicHero es la que se ve.
 */

/** El <video> va dentro de .cin-hero-media, sobre la foto: pausado, mudo, sin controles ni descarga previa. */
export function HeroFilmVideo() {
  return (
    <>
      <video
        data-film-video
        className="cin-film-video"
        muted
        playsInline
        preload="none"
        disablePictureInPicture
        disableRemotePlayback
        aria-hidden="true"
        tabIndex={-1}
      />
      <div className="cin-film-shade" aria-hidden="true" />
    </>
  );
}

/** Textos de escena (decorativos: el mensaje esencial está en el h1), cierre con el logo y salto accesible. */
export function HeroFilmOverlay({ afterId }: { afterId: string }) {
  const scenes = HERO_FILM.scenes.slice(0, -1);
  return (
    <>
      <ol className="cin-film-caps" aria-hidden="true">
        {scenes.map((s) => (
          <li key={s.key} className="cin-film-cap" data-film-cap>
            {s.title}
          </li>
        ))}
      </ol>

      <div className="cin-film-finale" data-film-finale aria-hidden="true" inert>
        {/* Logo oficial como archivo, sin alterar */}
        <Image
          src="/brand/logo-320.webp"
          alt="El Pan de Paula"
          width={320}
          height={320}
          className="cin-film-logo"
          loading="lazy"
        />
        <p className="cin-film-finale-line">Recién horneado, para tu fecha.</p>
        <div className="cin-film-finale-actions">
          <CinLink href="/menu">Ver menú</CinLink>
          <CinLink href="#como-pedir" variant="text">
            Cómo comprar
          </CinLink>
        </div>
      </div>

      <Link className="cin-film-menu" href="/menu">
        Ver menú
      </Link>
      <button type="button" className="cin-film-skip" data-film-skip aria-controls={afterId}>
        Saltar la historia
      </button>
    </>
  );
}
