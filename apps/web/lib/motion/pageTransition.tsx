"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";

/**
 * Transición de página mínima (≈320 ms, opacity + 8 px) al navegar en cliente.
 * No bloquea la navegación ni toca la primera carga (el hero/LCP se pinta sin opacidad 0):
 * la clase solo se aplica en cambios de ruta posteriores, antes del primer paint de la nueva página.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove("page-enter");
    void el.offsetWidth; // reinicia la animación aunque la ruta anterior también la haya usado
    el.classList.add("page-enter");
    const onEnd = () => el.classList.remove("page-enter");
    el.addEventListener("animationend", onEnd, { once: true });
    return () => el.removeEventListener("animationend", onEnd);
  }, [pathname]);

  return <div ref={ref}>{children}</div>;
}
