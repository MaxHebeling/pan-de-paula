/**
 * Ajustes del sistema de movimiento del sitio público (ver docs/WEB_MOTION.md).
 * Todo es opcional y degradable: sin JS o con `prefers-reduced-motion` el sitio se ve completo y estático.
 */
export const MOTION = {
  /** Lenis (desplazamiento suave) solo en desktop con puntero fino; se carga diferido tras el primer paint. */
  smoothScroll: true,
  /** Rutas "tranquilas": sin smooth scroll ni parallax; solo la transición mínima de página. */
  calmRoutes: [/^\/checkout/, /^\/carrito/, /^\/pedido\//, /^\/unete/, /^\/mi-tarjeta\//],
  /** Desplazamiento máximo del parallax (px). */
  parallaxMaxPx: 28,
  /** Profundidad del hero al mover el puntero (px). */
  heroDepthPx: 6,
  /** Atracción magnética de los CTA del hero (px). Nunca "huyen". */
  magneticMaxPx: 5,
  /** Inclinación máxima de las cards al pasar el puntero (grados). */
  tiltMaxDeg: 1.5,
  /** Duración de la mini representación que vuela al carrito (ms). */
  flyToCartMs: 420,
} as const;

export function isCalmRoute(pathname: string): boolean {
  return MOTION.calmRoutes.some((r) => r.test(pathname));
}

export const noop = (): void => {};

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Ejecuta `cb` cuando el hilo principal esté libre (o tras `timeout`). Devuelve un cancelador. */
export function onIdle(cb: () => void, timeout = 1500): () => void {
  if (typeof window === "undefined") return noop;
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, Math.min(timeout, 800));
  return () => window.clearTimeout(id);
}
