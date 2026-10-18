import "server-only";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import {
  HERO_FILM,
  type HeroFilmSources,
  type HeroFilmVariant,
} from "@/components/cinematic/heroFilm.config";

/**
 * Película de la portada: se detecta por archivos en apps/web/public/film/ (como las fotos de lib/storyPhotos.ts).
 * Sin archivos, la portada es la estática de siempre: nunca se inventa una ruta que no existe.
 *   del-amasado-al-aroma-horizontal.mp4  (+ …-horizontal.jpg, póster con el primer fotograma)
 *   del-amasado-al-aroma-vertical.mp4    (+ …-vertical.jpg)
 * El material provisional (`….provisional.mp4`) solo cuenta con HERO_FILM_PROVISIONAL=1 (pruebas locales).
 */
function nonEmpty(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

/*
 * La huella del archivo va en la URL, igual que en lib/storyPhotos.ts.
 *
 * Por qué importa más aquí que en una foto: Next sirve `public/` con
 * `cache-control: public, max-age=0, must-revalidate` porque los nombres no la llevan. En un video
 * que el scroll va buscando, eso significa que cada salto fuera del búfer paga una revalidación.
 * Medido contra producción el 14/10/2026: **200 ms por un 304 que devuelve cero bytes**, doce
 * fotogramas de 60 fps tirados por decir "no cambió". Con la huella en la URL el archivo se puede
 * declarar `immutable` (ver la regla de `/film/:path*` en next.config.ts) y el navegador deja de
 * preguntar; recodificar la película cambia la huella y por tanto la URL, así que nadie se queda
 * con la versión vieja.
 */
function huella(path: string): string {
  try {
    const { size, mtimeMs } = statSync(path);
    return `?v=${((size ^ Math.round(mtimeMs)) >>> 0).toString(36)}`;
  } catch {
    // Sin huella se sirve la ruta desnuda: pierde la caché inmutable, no la portada.
    return "";
  }
}

export function resolveHeroFilm(publicDir: string, allowProvisional: boolean): HeroFilmSources {
  const out: HeroFilmSources = {};
  const variants: HeroFilmVariant[] = ["horizontal", "vertical"];
  for (const variant of variants) {
    const suffixes = allowProvisional ? ["", HERO_FILM.provisionalSuffix] : [""];
    for (const suffix of suffixes) {
      const name = `${HERO_FILM.base}-${variant}${suffix}`;
      const video = join(publicDir, HERO_FILM.dir, `${name}.mp4`);
      if (!nonEmpty(video)) continue;
      const poster = join(publicDir, HERO_FILM.dir, `${name}.jpg`);
      out[variant] = {
        src: `/${HERO_FILM.dir}/${name}.mp4${huella(video)}`,
        poster: nonEmpty(poster) ? `/${HERO_FILM.dir}/${name}.jpg${huella(poster)}` : null,
        provisional: suffix !== "",
      };
      break;
    }
  }
  return out;
}

export const getHeroFilm = cache((): HeroFilmSources =>
  resolveHeroFilm(join(process.cwd(), "public"), process.env.HERO_FILM_PROVISIONAL === "1"),
);
