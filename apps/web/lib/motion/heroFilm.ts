import {
  HERO_FILM,
  HERO_FILM_VERTICAL_MQ,
  type HeroFilmVariant,
} from "@/components/cinematic/heroFilm.config";
import { noop, onIdle } from "./config";
import {
  createSeekScheduler,
  entranceOpacity,
  pinProgress,
  sceneIndex,
  timeForProgress,
} from "./heroFilmMath";
import { motionEnabled } from "./reducedMotion";

/**
 * Película de la portada controlada por el scroll (docs/HERO_FILM.md). Sin librerías: el progreso del
 * recorrido fijado (0–1) mueve `currentTime` del <video> pausado y elige la escena; los textos son HTML.
 *
 * Estados en `[data-hero-film]`: idle → loading → ready | failed. Solo "ready" fija la portada y muestra el
 * video; en cualquier otro estado la portada estática (foto real, titular y botones) es la que se ve.
 * Nunca se activa sin JS, con reduced motion ni con "ahorro de datos". Devuelve su limpieza.
 */
type State = "idle" | "loading" | "ready" | "failed";

export function initHeroFilm(root: HTMLElement): () => void {
  const video = root.querySelector<HTMLVideoElement>("video[data-film-video]");
  if (!video || !motionEnabled()) return noop;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return noop;

  const caps = Array.from(root.querySelectorAll<HTMLElement>("[data-film-cap]"));
  const finale = root.querySelector<HTMLElement>("[data-film-finale]");
  const skip = root.querySelector<HTMLButtonElement>("[data-film-skip]");
  const after = document.getElementById(root.dataset.filmAfter ?? "");
  const mq = window.matchMedia(HERO_FILM_VERTICAL_MQ);
  const scheduler = createSeekScheduler(video);

  let state: State = "idle";
  let variant: HeroFilmVariant | null = null;
  let raf = 0;
  let scene = -1;
  let stalls = 0;
  let readyTimer = 0;
  let stallTimer = 0;
  let cancelIdle: () => void = noop;

  const setState = (s: State) => {
    state = s;
    root.dataset.film = s;
  };
  const sourceFor = (v: HeroFilmVariant) =>
    root.dataset[`film${v === "horizontal" ? "H" : "V"}`] ?? "";
  const posterFor = (v: HeroFilmVariant) =>
    root.dataset[`filmPoster${v === "horizontal" ? "H" : "V"}`] ?? "";
  const wanted = (): HeroFilmVariant => (mq.matches ? "vertical" : "horizontal");

  const clearTimers = () => {
    window.clearTimeout(readyTimer);
    window.clearTimeout(stallTimer);
  };
  const release = () => {
    clearTimers();
    video.pause();
    video.removeAttribute("src");
    video.load();
  };

  const setFinaleActive = (on: boolean) => {
    if (!finale) return;
    finale.inert = !on;
    finale.setAttribute("aria-hidden", on ? "false" : "true");
  };

  /** Una fuente de progreso para todo: posición del video, escena, entrada y cierre. */
  const update = () => {
    raf = 0;
    if (state !== "ready") return;
    const r = root.getBoundingClientRect();
    const p = pinProgress(r.top, r.height, window.innerHeight);
    if (scheduler.seek(timeForProgress(p, video.duration, HERO_FILM.edgeSeconds))) armStall();
    const entrance = entranceOpacity(p, HERO_FILM.entranceUntil);
    root.style.setProperty("--film-entrance", entrance.toFixed(3));
    // Sin opacidad la entrada tampoco se enfoca ni se toca (sus botones siguen en el cierre y en "Ver menú").
    root.toggleAttribute("data-film-entered", entrance < 0.05);
    const next = sceneIndex(p, HERO_FILM.scenes);
    if (next !== scene) {
      scene = next;
      root.dataset.scene = String(next);
      caps.forEach((c, i) => c.classList.toggle("is-active", i === next));
      setFinaleActive(next === HERO_FILM.scenes.length - 1);
    }
  };
  const schedule = () => {
    if (!raf) raf = window.requestAnimationFrame(update);
  };

  const armStall = () => {
    window.clearTimeout(stallTimer);
    stallTimer = window.setTimeout(() => {
      stalls++;
      if (stalls >= 2) fail();
    }, HERO_FILM.seekStallMs);
  };
  const onSeeked = () => {
    window.clearTimeout(stallTimer);
    stalls = 0;
    if (scheduler.onSeeked()) armStall();
  };

  /** Vuelve a la portada estática sin recargar; si la portada estaba fijada, el visitante no pierde su lugar. */
  function fail() {
    if (state === "failed") return;
    const wasReady = state === "ready";
    const r = root.getBoundingClientRect();
    const p = wasReady ? pinProgress(r.top, r.height, window.innerHeight) : 0;
    release();
    setState("failed");
    setFinaleActive(false);
    root.removeAttribute("data-film-entered");
    root.style.removeProperty("--film-screens");
    if (wasReady && p > 0) {
      const top = root.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: p > 0.5 ? top + root.offsetHeight : top, behavior: "instant" });
    }
  }

  const onLoadedData = () => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return fail();
    video.addEventListener(
      "seeked",
      () => {
        window.clearTimeout(readyTimer);
        // Nunca un salto a mitad de lectura: se fija si el visitante sigue arriba, o si la portada ya quedó
        // entera por encima (p. ej. al volver de otra página) compensando la altura que se agrega.
        const before = root.getBoundingClientRect();
        const above = before.bottom <= 0;
        if (state === "loading" && window.scrollY > HERO_FILM.activateMaxScrollY && !above) {
          release();
          setState("failed");
          return;
        }
        setState("ready");
        root.style.setProperty(
          "--film-screens",
          String(HERO_FILM.pinScreens[variant ?? "horizontal"]),
        );
        if (above) window.scrollBy({ top: root.offsetHeight - before.height, behavior: "instant" });
        scene = -1;
        update();
      },
      { once: true },
    );
    video.currentTime = timeForProgress(0, video.duration, HERO_FILM.edgeSeconds);
  };

  const load = (v: HeroFilmVariant) => {
    const src = sourceFor(v);
    if (!src) return fail(); // sin composición para este formato: nunca se recorta la otra
    variant = v;
    setState("loading");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const poster = posterFor(v);
    if (poster) video.poster = poster;
    video.src = src;
    video.load();
    readyTimer = window.setTimeout(fail, HERO_FILM.readyTimeoutMs);
  };

  const onVariantChange = () => {
    const v = wanted();
    if (v === variant || state === "failed") return;
    // Cambio de orientación: se carga solo la otra composición y se vuelve a fijar al estar lista.
    clearTimers();
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    load(v);
  };
  const onSkip = () => {
    const top = root.getBoundingClientRect().top + window.scrollY + root.offsetHeight;
    window.scrollTo({ top, behavior: "instant" });
    after?.focus({ preventScroll: true });
  };
  const onError = () => fail();

  video.addEventListener("seeked", onSeeked);
  video.addEventListener("error", onError);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", schedule);
  mq.addEventListener("change", onVariantChange);
  skip?.addEventListener("click", onSkip);
  setFinaleActive(false);

  // Primero la portada estática completa; la película se pide cuando el hilo está libre.
  cancelIdle = onIdle(() => {
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    load(wanted());
  }, 1200);

  return () => {
    cancelIdle();
    if (raf) window.cancelAnimationFrame(raf);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("error", onError);
    video.removeEventListener("loadeddata", onLoadedData);
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("pageshow", schedule);
    document.removeEventListener("visibilitychange", schedule);
    mq.removeEventListener("change", onVariantChange);
    skip?.removeEventListener("click", onSkip);
    release();
    setFinaleActive(false);
    root.removeAttribute("data-film");
    root.removeAttribute("data-scene");
    root.removeAttribute("data-film-entered");
    root.style.removeProperty("--film-screens");
    root.style.removeProperty("--film-entrance");
    caps.forEach((c) => c.classList.remove("is-active"));
  };
}
