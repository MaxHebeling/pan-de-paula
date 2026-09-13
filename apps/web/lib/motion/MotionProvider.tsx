"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { isCalmRoute, onIdle } from "./config";
import { initHeroDepth } from "./hero";
import { initMagnetic } from "./magnetic";
import { initParallax } from "./parallax";
import { initCardTilt } from "./productCards";
import { syncMotionAttribute } from "./reducedMotion";
import { initScrollReveal } from "./scrollReveal";
import { destroySmoothScroll, initSmoothScroll } from "./smoothScroll";

/**
 * Orquesta el sistema de movimiento por ruta. No renderiza nada.
 * Orden: primero lo barato (observers, listeners) tras hidratar; Lenis solo cuando el hilo está libre.
 * Cada init devuelve su limpieza; al cambiar de ruta se desmonta todo y se vuelve a inicializar.
 */
export function MotionProvider() {
  const pathname = usePathname();

  useEffect(() => syncMotionAttribute(), []);

  useEffect(() => {
    const calm = isCalmRoute(pathname);
    const cleanups: Array<() => void> = [initScrollReveal(), initCardTilt()];
    if (!calm) {
      cleanups.push(initParallax(), initMagnetic());
      const hero = document.querySelector<HTMLElement>("[data-hero]");
      if (hero) cleanups.push(initHeroDepth(hero));
    }

    let cancelled = false;
    let cancelIdle = () => {};
    if (calm) destroySmoothScroll();
    else
      cancelIdle = onIdle(() => {
        if (!cancelled) void initSmoothScroll();
      }, 2500);

    return () => {
      cancelled = true;
      cancelIdle();
      for (const c of cleanups) c();
    };
  }, [pathname]);

  useEffect(() => () => destroySmoothScroll(), []);

  return null;
}
