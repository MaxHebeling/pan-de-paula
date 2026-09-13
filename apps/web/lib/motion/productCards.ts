import { MOTION, clamp, noop } from "./config";
import { finePointer, motionEnabled } from "./reducedMotion";

/**
 * Microinteracciones de las cards de producto (jerarquía C).
 * - initCardTilt: inclinación ≤ 1.5° siguiendo el puntero en `[data-tilt]` (desktop). Escribe variables CSS;
 *   el transform vive en `.card-hover` (app/motion.css), así no compite con hover ni reveals.
 * - flyToCart: una sola mini representación (círculo) vuela del botón al icono del carrito con WAAPI.
 * - nudgeCard: el producto responde al "Agregar" con un micro-movimiento de su imagen.
 */
export function initCardTilt(): () => void {
  if (!motionEnabled() || !finePointer()) return noop;
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-tilt]"));
  if (els.length === 0) return noop;
  const max = MOTION.tiltMaxDeg;
  const cleanups = els.map((el) => {
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        el.style.setProperty("--ry", `${clamp(px * 2 * max, -max, max).toFixed(2)}deg`);
        el.style.setProperty("--rx", `${clamp(-py * 2 * max, -max, max).toFixed(2)}deg`);
      });
    };
    const onLeave = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      el.style.removeProperty("--rx");
      el.style.removeProperty("--ry");
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

/** Micro-movimiento del producto al agregarlo (clase temporal en la card contenedora). */
export function nudgeCard(from: Element | null): void {
  if (!motionEnabled()) return;
  const card = from?.closest<HTMLElement>("[data-product-card]");
  if (!card) return;
  card.classList.remove("is-added");
  void card.offsetWidth; // reinicia la animación si se agrega dos veces seguidas
  card.classList.add("is-added");
  window.setTimeout(() => card.classList.remove("is-added"), 600);
}

/**
 * Vuela un punto del botón al carrito. Resuelve cuando termina (o de inmediato si no aplica:
 * reduced motion, sin destino visible, sin WAAPI). Un solo elemento, solo transform/opacity, sin layout.
 */
export function flyToCart(from: Element | null): Promise<void> {
  if (!motionEnabled() || !from || typeof document === "undefined") return Promise.resolve();
  const target = document.querySelector<HTMLElement>("[data-cart-target]");
  if (!target || !("animate" in HTMLElement.prototype)) return Promise.resolve();
  const a = from.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  if (b.width === 0 || a.width === 0) return Promise.resolve();

  const dot = document.createElement("span");
  dot.className = "fly-dot";
  dot.setAttribute("aria-hidden", "true");
  const size = 14;
  dot.style.left = `${a.left + a.width / 2 - size / 2}px`;
  dot.style.top = `${a.top + a.height / 2 - size / 2}px`;
  document.body.appendChild(dot);

  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = dot.animate(
    [
      { transform: "translate3d(0,0,0) scale(1)", opacity: 1 },
      { transform: `translate3d(${dx * 0.5}px, ${dy * 0.5 - 40}px, 0) scale(0.9)`, opacity: 1 },
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.35)`, opacity: 0.6 },
    ],
    { duration: MOTION.flyToCartMs, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "forwards" },
  );
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dot.remove();
      resolve();
    };
    anim.addEventListener("finish", finish);
    anim.addEventListener("cancel", finish);
    window.setTimeout(finish, MOTION.flyToCartMs + 150); // por si el navegador no emite finish
  });
}
