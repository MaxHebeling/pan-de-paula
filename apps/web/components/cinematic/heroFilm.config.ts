/**
 * Película de la portada «Del amasado al aroma» (ver docs/HERO_FILM.md).
 * Única fuente de verdad de escenas, textos, archivos, recorridos de scroll y tiempos de espera.
 * Los tramos (`from`/`to`, 0–1) se ajustan al montaje final de la película, no al revés.
 */

export type HeroFilmVariant = "horizontal" | "vertical";

export const HERO_FILM = {
  /** Carpeta pública donde se colocan los archivos (apps/web/public/film). */
  dir: "film",
  /** Nombre base de los archivos: del-amasado-al-aroma-horizontal.mp4, …-vertical.mp4 y sus pósters .jpg. */
  base: "del-amasado-al-aroma",
  /**
   * Material provisional (clip de prueba con la leyenda «MATERIAL PROVISIONAL»): solo se detecta con
   * HERO_FILM_PROVISIONAL=1 y nunca se versiona (.gitignore). Sirve para validar el motor sin la película real.
   */
  provisionalSuffix: ".provisional",
  /** Escenas y su tramo del recorrido. El texto es HTML (nunca va dentro del video). */
  scenes: [
    { key: "origen", from: 0, to: 0.2, title: "Hecho con tiempo" },
    { key: "laminado", from: 0.2, to: 0.4, title: "Laminado a mano" },
    { key: "forma", from: 0.4, to: 0.6, title: "Pieza por pieza" },
    { key: "horno", from: 0.6, to: 0.82, title: "Recién horneado" },
    { key: "resultado", from: 0.82, to: 1, title: "El Pan de Paula" },
  ],
  /** Hasta qué progreso se ve la entrada (titular, texto y botones) antes de ceder a la película. */
  entranceUntil: 0.08,
  /** Longitud del recorrido fijado: pantallas de scroll que dura la historia (móvil, más corto). */
  pinScreens: { horizontal: 4.2, vertical: 3 },
  /** Recorte de seguridad al inicio y final del archivo (s) para no buscar el fotograma 0 ni el último. */
  edgeSeconds: 0.04,
  /** Sin datos suficientes para mostrar un fotograma en este tiempo → portada estática. */
  readyTimeoutMs: 10_000,
  /** Una búsqueda que no termina en este tiempo cuenta como atasco; dos atascos → portada estática. */
  seekStallMs: 2_500,
  /** La película solo se activa si el visitante no ha bajado más que esto cuando ya está lista. */
  activateMaxScrollY: 48,
} as const;

export type HeroFilmScene = (typeof HERO_FILM.scenes)[number];

/** Archivos de una variante, ya resueltos a rutas públicas. Los produce lib/heroFilm.ts (servidor). */
export type HeroFilmSource = { src: string; poster: string | null; provisional: boolean };
export type HeroFilmSources = Partial<Record<HeroFilmVariant, HeroFilmSource>>;

/** Ancho a partir del cual se usa la composición horizontal (y en vertical, la de móvil). */
export const HERO_FILM_VERTICAL_MQ = "(max-width: 900px) and (orientation: portrait)";
