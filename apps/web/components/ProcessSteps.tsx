"use client";

import { useEffect, useRef } from "react";

/**
 * Marca el paso activo de "Del horno a tu mesa" según el scroll (banda central del viewport)
 * y sincroniza la capa de imagen correspondiente. Sin JS: primera imagen visible y todos los textos a color.
 * Funciona también con reduced motion (el cambio de imagen es instantáneo porque el CSS quita las transiciones).
 */
export function ProcessSteps({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const steps = Array.from(el.querySelectorAll<HTMLElement>(".story-step[data-step]"));
    const layers = Array.from(el.querySelectorAll<HTMLElement>(".story-art-layer[data-step]"));
    if (steps.length === 0) return;
    const desktop = window.matchMedia("(min-width: 1024px)");

    const activate = (idx: string) => {
      for (const s of steps) s.classList.toggle("is-active", s.dataset.step === idx);
      for (const l of layers) l.classList.toggle("is-active", l.dataset.step === idx);
    };
    const clear = () => {
      for (const s of steps) s.classList.remove("is-active");
      for (const l of layers) l.classList.remove("is-active");
    };

    let io: IntersectionObserver | null = null;
    const start = () => {
      io?.disconnect();
      io = null;
      if (!desktop.matches) {
        clear();
        return;
      }
      io = new IntersectionObserver(
        (entries) => {
          const hit = entries.find((e) => e.isIntersecting);
          if (hit) activate((hit.target as HTMLElement).dataset.step ?? "0");
        },
        { rootMargin: "-42% 0px -42% 0px", threshold: 0 },
      );
      for (const s of steps) io.observe(s);
    };
    start();
    desktop.addEventListener("change", start);
    return () => {
      desktop.removeEventListener("change", start);
      io?.disconnect();
      clear();
    };
  }, []);

  return <div ref={root}>{children}</div>;
}
