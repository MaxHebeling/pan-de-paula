"use client";

import { useEffect, useState } from "react";

/**
 * Cabecera fija: transparente en la parte superior de la página y con fondo + blur tras el primer scroll.
 * Estado inicial "true" (con fondo) en servidor para que sin JS la cabecera siempre sea legible.
 */
export function HeaderShell({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = useState(true);

  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      setScrolled(window.scrollY > 12);
    };
    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <header
      className="site-header sticky top-0 z-40 border-b border-line/70 bg-cream/85 backdrop-blur supports-[backdrop-filter]:bg-cream/70"
      data-scrolled={scrolled ? "true" : "false"}
    >
      {children}
    </header>
  );
}
