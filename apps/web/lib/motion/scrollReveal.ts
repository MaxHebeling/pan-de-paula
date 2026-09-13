import { noop } from "./config";
import { motionEnabled } from "./reducedMotion";

/**
 * Revelado al hacer scroll (jerarquía B) con IntersectionObserver, sin librerías.
 *
 * Progresivo por diseño: nada arranca oculto en el HTML. Al inicializar, solo lo que está
 * completamente por debajo del viewport recibe `.reveal-wait` (opacity 0 + transform); lo que ya
 * se ve, o ya se vio, queda visible. Al entrar en pantalla se cambia por `.reveal-in`, que transiciona.
 * Con reduced motion o sin JS no pasa nada: todo se ve.
 *
 * Marcado: `data-reveal="up|fade|scale|card|left|none"` y, opcionalmente, `--reveal-delay` (stagger).
 * Dentro de una fila con scroll horizontal (`[data-reveal-row]` que desborda, p. ej. el showcase en móvil) no se
 * oculta nada: el scroller recorta la intersección y lo que está fuera a los lados nunca se revelaría al bajar.
 * Hijos con `.reveal-img`, `.reveal-text` o `.word` se animan en cascada desde el CSS (app/motion.css).
 */
export const REVEAL_WAIT = "reveal-wait";
export const REVEAL_IN = "reveal-in";

export function initScrollReveal(root: ParentNode = document): () => void {
  const els = Array.from(root.querySelectorAll<HTMLElement>(`[data-reveal]:not(.${REVEAL_IN})`));
  if (els.length === 0) return noop;
  if (!motionEnabled() || !("IntersectionObserver" in window)) {
    for (const el of els) el.classList.add(REVEAL_IN);
    return noop;
  }

  // Stagger automático dentro de grupos que no traen retraso explícito.
  for (const group of Array.from(root.querySelectorAll<HTMLElement>("[data-reveal-group]"))) {
    const step = Number(group.dataset.revealGroup) || 70;
    let i = 0;
    for (const child of Array.from(group.querySelectorAll<HTMLElement>("[data-reveal]"))) {
      if (!child.style.getPropertyValue("--reveal-delay"))
        child.style.setProperty("--reveal-delay", `${Math.min(i, 8) * step}ms`);
      i++;
    }
  }

  const inHorizontalRow = (el: HTMLElement) => {
    const row = el.closest<HTMLElement>("[data-reveal-row]");
    return Boolean(row && row.scrollWidth > row.clientWidth + 1);
  };

  const show = (el: HTMLElement) => {
    el.classList.remove(REVEAL_WAIT);
    el.classList.add(REVEAL_IN);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) {
          show(el);
          io.unobserve(el);
        } else if (!el.classList.contains(REVEAL_IN) && !el.classList.contains(REVEAL_WAIT)) {
          // Primera observación: solo se oculta lo que está entero por debajo del viewport.
          if (e.boundingClientRect.top >= window.innerHeight && !inHorizontalRow(el))
            el.classList.add(REVEAL_WAIT);
          else {
            show(el);
            io.unobserve(el);
          }
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0 },
  );
  for (const el of els) io.observe(el);

  return () => {
    io.disconnect();
    // Nunca dejar contenido oculto al desmontar (p. ej. cambio de ruta a mitad de scroll).
    for (const el of els) if (el.classList.contains(REVEAL_WAIT)) show(el);
  };
}
