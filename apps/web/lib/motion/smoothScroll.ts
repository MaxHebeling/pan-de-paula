import type Lenis from "lenis";
import { MOTION } from "./config";
import { finePointer, motionEnabled } from "./reducedMotion";

/**
 * Desplazamiento suave con Lenis, cargado de forma diferida (import dinámico tras el primer paint)
 * y solo cuando aporta: desktop con puntero fino, viewport ≥ 1024 px, sin reduced motion.
 * En táctil el scroll nativo es mejor; `syncTouch` queda apagado siempre.
 * Un solo singleton por documento: initSmoothScroll() es idempotente y destroySmoothScroll() limpia todo.
 */
let lenis: Lenis | null = null;
let loading: Promise<Lenis | null> | null = null;

export function smoothScrollApplies(): boolean {
  return (
    MOTION.smoothScroll &&
    motionEnabled() &&
    finePointer() &&
    window.matchMedia("(min-width: 1024px)").matches
  );
}

export function initSmoothScroll(): Promise<Lenis | null> {
  if (lenis) return Promise.resolve(lenis);
  if (loading) return loading;
  if (!smoothScrollApplies()) return Promise.resolve(null);
  loading = import("lenis")
    .then(({ default: LenisCtor }) => {
      if (lenis) return lenis;
      if (!smoothScrollApplies()) return null;
      lenis = new LenisCtor({
        lerp: 0.12,
        smoothWheel: true,
        syncTouch: false,
        anchors: true,
        autoRaf: true,
        allowNestedScroll: true,
      });
      return lenis;
    })
    .catch((e: unknown) => {
      console.error("[motion] no se pudo cargar el desplazamiento suave", e);
      return null;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function destroySmoothScroll(): void {
  lenis?.destroy();
  lenis = null;
}

/** Mientras un diálogo bloquea el scroll (carrito), Lenis también se detiene. Sin Lenis no hace nada. */
export function pauseSmoothScroll(): void {
  lenis?.stop();
}

export function resumeSmoothScroll(): void {
  lenis?.start();
}
