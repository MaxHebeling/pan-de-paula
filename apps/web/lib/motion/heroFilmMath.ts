import { clamp } from "./config";

/**
 * Cálculos puros de la película de la portada (sin DOM): una sola fuente de progreso (0–1) de la que salen
 * la posición del video, la escena activa y la opacidad de la entrada.
 */

/** Progreso del recorrido fijado: 0 cuando la portada toca el borde superior, 1 al soltarse. */
export function pinProgress(rectTop: number, rectHeight: number, viewport: number): number {
  const travel = rectHeight - viewport;
  if (!(travel > 0)) return 0;
  return clamp(-rectTop / travel, 0, 1);
}

/** Tiempo del video para un progreso, dentro de [edge, duration − edge]. NaN/0 → 0. */
export function timeForProgress(p: number, duration: number, edge: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const lo = Math.min(edge, duration / 2);
  const hi = Math.max(lo, duration - edge);
  return lo + clamp(p, 0, 1) * (hi - lo);
}

/** Índice de la escena activa: la última cuyo tramo ya empezó (la primera mientras p < su inicio). */
export function sceneIndex(p: number, scenes: ReadonlyArray<{ from: number }>): number {
  let index = 0;
  for (let i = 0; i < scenes.length; i++) if (p >= scenes[i]!.from) index = i;
  return index;
}

/** Opacidad de la entrada: 1 hasta el inicio y se desvanece linealmente hasta `until`. */
export function entranceOpacity(p: number, until: number): number {
  return until > 0 ? clamp(1 - p / until, 0, 1) : p > 0 ? 0 : 1;
}

/** Lo mínimo del <video> que usa el programador de búsquedas (permite probarlo con un doble). */
export type Seekable = { currentTime: number; readonly seeking: boolean };

/**
 * Programa búsquedas sin acumularlas: si el video está buscando, solo se recuerda el ÚLTIMO destino pedido
 * y se aplica al terminar (`onSeeked`). Diferencias menores a `epsilon` (≈ medio fotograma) se ignoran.
 */
export function createSeekScheduler(video: Seekable, epsilon = 1 / 48) {
  let pending: number | null = null;
  let requested = 0;
  const apply = (t: number) => {
    if (Math.abs(video.currentTime - t) < epsilon) return false;
    video.currentTime = t;
    requested++;
    return true;
  };
  return {
    /** Pide ir a `t`. Devuelve true si inició una búsqueda ahora. */
    seek(t: number): boolean {
      if (video.seeking) {
        pending = t;
        return false;
      }
      pending = null;
      return apply(t);
    },
    /** Llamar en el evento `seeked`: aplica el destino más reciente que quedó en espera. */
    onSeeked(): boolean {
      if (pending === null) return false;
      const t = pending;
      pending = null;
      return apply(t);
    },
    get pending() {
      return pending;
    },
    get requested() {
      return requested;
    },
  };
}
