"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Cabecera fija: transparente en la parte superior de la página y con fondo + blur tras el primer scroll.
 * En el home (hay `[data-hero-pin]`) sigue transparente, con texto claro, mientras la portada oscura está
 * detrás, y pasa a sólida al terminarla. Antes de hidratar no lleva `data-scrolled`: sin JS la cabecera
 * mantiene su fondo (las reglas "sobre la portada" exigen `html[data-motion]`, que solo existe con JS).
 */
export function HeaderShell({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState<boolean | null>(null);
  const ref = useRef<HTMLElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      const hero = document.querySelector<HTMLElement>("[data-hero-pin]");
      const header = ref.current?.offsetHeight ?? 0;
      const limit = hero ? Math.max(12, hero.offsetTop + hero.offsetHeight - header - 8) : 12;
      setScrolled(window.scrollY > limit);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [pathname]);

  return (
    <header
      ref={ref}
      className="site-header sticky top-0 z-40 border-b border-line/70 bg-cream/85 backdrop-blur supports-[backdrop-filter]:bg-cream/70"
      data-scrolled={scrolled === null ? undefined : scrolled ? "true" : "false"}
    >
      {children}
    </header>
  );
}
