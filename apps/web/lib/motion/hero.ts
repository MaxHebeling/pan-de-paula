import { MOTION, clamp, noop } from "./config";
import { finePointer, motionEnabled } from "./reducedMotion";

/**
 * Profundidad del hero (jerarquía A): las capas `[data-depth="1"]`, `[data-depth="-0.5"]`… siguen el puntero
 * unos pocos píxeles (MOTION.heroDepthPx) con interpolación suave. La secuencia de entrada es CSS puro
 * (app/motion.css); este módulo solo añade el movimiento continuo en desktop.
 */
export function initHeroDepth(root: HTMLElement): () => void {
  if (!motionEnabled() || !finePointer()) return noop;
  const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-depth]")).map((el) => ({
    el,
    depth: clamp(Number(el.dataset.depth) || 1, -2, 2),
  }));
  if (layers.length === 0) return noop;

  let raf = 0;
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  const max = MOTION.heroDepthPx;

  const tick = () => {
    cx += (tx - cx) * 0.1;
    cy += (ty - cy) * 0.1;
    for (const { el, depth } of layers)
      el.style.transform = `translate3d(${(cx * depth).toFixed(2)}px, ${(cy * depth).toFixed(2)}px, 0)`;
    raf =
      Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05 ? window.requestAnimationFrame(tick) : 0;
  };
  const kick = () => {
    if (!raf) raf = window.requestAnimationFrame(tick);
  };
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1) * max;
    ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1) * max;
    kick();
  };
  const onLeave = () => {
    tx = 0;
    ty = 0;
    kick();
  };
  root.addEventListener("pointermove", onMove, { passive: true });
  root.addEventListener("pointerleave", onLeave);

  return () => {
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerleave", onLeave);
    if (raf) window.cancelAnimationFrame(raf);
    for (const { el } of layers) el.style.transform = "";
  };
}
