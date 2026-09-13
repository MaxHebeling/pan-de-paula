import { MOTION, clamp, noop } from "./config";
import { finePointer, motionEnabled } from "./reducedMotion";

/**
 * Botones magnéticos MUY sutiles (`[data-magnetic]`): se acercan al puntero hasta MOTION.magneticMaxPx.
 * Solo desktop; nunca se alejan del cursor. La suavidad la da la transición CSS de transform.
 */
export function initMagnetic(): () => void {
  if (!motionEnabled() || !finePointer()) return noop;
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-magnetic]"));
  if (els.length === 0) return noop;
  const max = MOTION.magneticMaxPx;

  const cleanups = els.map((el) => {
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = clamp((e.clientX - (r.left + r.width / 2)) * 0.12, -max, max);
      const y = clamp((e.clientY - (r.top + r.height / 2)) * 0.12, -max, max);
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      });
    };
    const onLeave = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      el.style.transform = "";
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      onLeave();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  });
  return () => cleanups.forEach((c) => c());
}
