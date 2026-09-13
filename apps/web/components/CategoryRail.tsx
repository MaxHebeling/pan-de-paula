"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Category } from "@/lib/catalog";
import { ProductArt } from "./ProductArt";

/**
 * Exploración visual de categorías: fila con scroll-snap. Swipe natural en móvil; en desktop botones
 * anterior/siguiente accesibles (y las tarjetas siguen siendo enlaces normales, navegables con Tab).
 * Cada tarjeta enlaza a /menu/[categoria]; no cambia rutas ni datos.
 */
export function CategoryRail({ categories }: { categories: Category[] }) {
  const rail = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = rail.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    measure();
    let raf = 0;
    const onScroll = () => {
      if (!raf)
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          measure();
        });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [measure]);

  const page = (dir: 1 | -1) => {
    const el = rail.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.8), behavior: "smooth" });
  };

  const scrollable = !(edges.start && edges.end);

  return (
    <div className="relative">
      <ul
        ref={rail}
        className="rail -mx-4 flex snap-x snap-proximity scroll-px-4 gap-4 overflow-x-auto scroll-smooth px-4 pb-2 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:scroll-px-0 lg:px-0"
        aria-label="Categorías del menú"
        data-lenis-prevent-wheel
      >
        {categories.map((c) => (
          <li
            key={c.id}
            className="w-[68%] shrink-0 sm:w-[calc(50%-0.5rem)] lg:w-[calc(25%-0.75rem)]"
          >
            <Link
              href={`/menu/${c.slug}`}
              className="rail-card card group relative block aspect-[4/5] overflow-hidden"
              data-testid="category-card"
            >
              <span className="card-img absolute inset-0 block">
                <ProductArt name={c.name} seed={c.slug} className="h-full w-full" large />
              </span>
              <span
                className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-ink/70 to-transparent"
                aria-hidden="true"
              />
              <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4 text-cream">
                <span>
                  <span className="block font-display text-xl leading-tight">{c.name}</span>
                  <span className="text-xs text-cream/80">
                    {c.productCount} {c.productCount === 1 ? "producto" : "productos"}
                  </span>
                </span>
                <span
                  className="btn-icon inline-flex h-9 w-9 items-center justify-center rounded-full bg-cream/15 text-cream ring-1 ring-cream/40 backdrop-blur-sm"
                  aria-hidden="true"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {scrollable && (
        <div
          className="mt-4 hidden justify-end gap-2 md:flex"
          role="group"
          aria-label="Desplazar categorías"
        >
          <button
            type="button"
            className="stepper-btn"
            onClick={() => page(-1)}
            disabled={edges.start}
            aria-label="Categorías anteriores"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="stepper-btn"
            onClick={() => page(1)}
            disabled={edges.end}
            aria-label="Siguientes categorías"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
