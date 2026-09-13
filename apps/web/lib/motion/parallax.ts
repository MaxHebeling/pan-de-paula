import { MOTION, clamp, noop } from "./config";
import { finePointer, motionEnabled } from "./reducedMotion";

/**
 * Parallax sutil (±28 px máx.) en `[data-parallax="0.12"]` (factor respecto al centro del viewport).
 * Solo desktop con puntero fino: en táctil el scroll es asíncrono y el efecto vibra. Solo transform.
 * Lecturas y escrituras separadas por frame para no forzar layout por elemento.
 */
export function initParallax(): () => void {
  if (!motionEnabled() || !finePointer()) return noop;
  const items = Array.from(document.querySelectorAll<HTMLElement>("[data-parallax]")).map((el) => ({
    el,
    speed: clamp(Number(el.dataset.parallax) || 0.12, -0.5, 0.5),
  }));
  if (items.length === 0) return noop;

  let raf = 0;
  const update = () => {
    raf = 0;
    const vh = window.innerHeight;
    const rects = items.map((i) => i.el.getBoundingClientRect());
    items.forEach(({ el, speed }, idx) => {
      const r = rects[idx]!;
      if (r.bottom < -MOTION.parallaxMaxPx || r.top > vh + MOTION.parallaxMaxPx) return;
      const offset = r.top + r.height / 2 - vh / 2;
      const y = clamp(-offset * speed, -MOTION.parallaxMaxPx, MOTION.parallaxMaxPx);
      el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
    });
  };
  const schedule = () => {
    if (!raf) raf = window.requestAnimationFrame(update);
  };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  schedule();

  return () => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    if (raf) window.cancelAnimationFrame(raf);
    for (const { el } of items) el.style.transform = "";
  };
}
