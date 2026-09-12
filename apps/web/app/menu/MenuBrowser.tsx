"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import type { CatalogProduct } from "@/lib/catalog";
import { availability } from "@/lib/availability";
import { ProductCard } from "@/components/ProductCard";

type Filter = "todos" | "nuevo" | "temporada" | "pedido" | "promo";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "todos", label: "Todo" },
  { key: "nuevo", label: "Nuevos" },
  { key: "promo", label: "Promociones" },
  { key: "temporada", label: "Temporada" },
  { key: "pedido", label: "Bajo pedido" },
];

function norm(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function MenuBrowser({
  products,
  categories,
  activeCategory,
}: {
  products: CatalogProduct[];
  categories: Array<{ slug: string; name: string; productCount: number }>;
  activeCategory: string | null;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const dq = useDeferredValue(q);

  const visible = useMemo(() => {
    const needle = norm(dq.trim());
    return products.filter((p) => {
      if (filter !== "todos" && !availability(p).badges.some((b) => b.key === filter)) return false;
      if (!needle) return true;
      const hay = norm(
        [p.name, p.shortDescription ?? "", p.categoryName ?? "", ...p.tags, ...p.highlightedIngredients].join(" "),
      );
      return hay.includes(needle);
    });
  }, [products, dq, filter]);

  const hasAnyFilterable = (key: Filter) =>
    key === "todos" || products.some((p) => availability(p).badges.some((b) => b.key === key));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <nav aria-label="Categorías" className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <ul className="flex gap-2 whitespace-nowrap">
            <li>
              <Link href="/menu" className={`chip ${!activeCategory ? "chip-active" : ""}`} aria-current={!activeCategory ? "page" : undefined}>
                Todo
              </Link>
            </li>
            {categories.map((c) => (
              <li key={c.slug}>
                <Link
                  href={`/menu/${c.slug}`}
                  className={`chip ${activeCategory === c.slug ? "chip-active" : ""}`}
                  aria-current={activeCategory === c.slug ? "page" : undefined}
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <label className="relative block md:w-72">
          <span className="sr-only">Buscar en el menú</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar: croissant, nuez, canela…"
            className="input pl-10"
            data-testid="menu-search"
          />
          <svg className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-2" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros">
        {FILTERS.filter((f) => hasAnyFilterable(f.key)).map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`chip ${filter === f.key ? "chip-active" : ""}`}
            aria-pressed={filter === f.key}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-ink-2" aria-live="polite">
          {visible.length} {visible.length === 1 ? "producto" : "productos"}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="font-display text-2xl text-ink">No encontramos eso</p>
          <p className="mt-2 text-sm text-ink-2">Prueba con otra palabra o quita los filtros.</p>
          <button
            type="button"
            className="btn btn-secondary mt-4"
            onClick={() => {
              setQ("");
              setFilter("todos");
            }}
          >
            Limpiar búsqueda
          </button>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="menu-grid">
          {visible.map((p, i) => (
            <ProductCard key={p.id} p={p} priority={i < 4} />
          ))}
        </div>
      )}
    </div>
  );
}
