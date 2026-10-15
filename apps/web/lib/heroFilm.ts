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
        src: `/${HERO_FILM.dir}/${name}.mp4`,
        poster: nonEmpty(poster) ? `/${HERO_FILM.dir}/${name}.jpg` : null,
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
