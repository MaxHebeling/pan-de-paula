"use client";
import { useDeferredValue, useMemo, useState, type RefObject } from "react";
import Image from "next/image";
import { Search, Star, X } from "lucide-react";
import { formatMXN } from "@pdp/domain";
import type { PosCatalog, PosProduct } from "./types";

type Group = { main: PosProduct; variants: PosProduct[] };

function normalize(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function matches(p: PosProduct, q: string) {
  if (!q) return true;
  return (
    normalize(p.name).includes(q) ||
    (p.sku ? normalize(p.sku).includes(q) : false) ||
    (p.variantLabel ? normalize(p.variantLabel).includes(q) : false)
  );
}

function StockBadge({ p, allowNegative }: { p: PosProduct; allowNegative: boolean }) {
  if (!p.trackStock) return null;
  if (p.level === "out")
    return (
      <span
        className={`pill px-2 py-0.5 text-[11px] font-semibold ${allowNegative ? "st-amber" : "st-red"}`}
      >
        Agotado
      </span>
    );
  if (p.level === "low")
    return (
      <span className="st-amber pill px-2 py-0.5 text-[11px] font-semibold">Quedan {p.onHand}</span>
    );
  return null;
}

function Thumb({ p }: { p: PosProduct }) {
  if (p.imageUrl) {
    return (
      <div className="relative h-20 w-full overflow-hidden rounded-[10px] bg-black/5">
        <Image src={p.imageUrl} alt="" fill sizes="200px" className="object-cover" unoptimized />
      </div>
    );
  }
  const initials = p.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div
      className="flex h-20 w-full items-center justify-center rounded-[10px] text-2xl font-semibold text-teal-deep"
      style={{ background: "linear-gradient(135deg, rgba(10,156,184,.14), rgba(28,192,216,.28))" }}
      aria-hidden
    >
      {initials}
    </div>
  );
}

export function ProductGrid({
  catalog,
  onAdd,
  searchRef,
  allowNegativeStock,
}: {
  catalog: PosCatalog;
  onAdd: (p: PosProduct) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  allowNegativeStock: boolean;
}) {
  const hasFavorites = catalog.products.some((p) => p.favorite);
  const [tab, setTab] = useState<string>(hasFavorites ? "fav" : "all");
  const [query, setQuery] = useState("");
  const q = normalize(useDeferredValue(query).trim());

  const groups = useMemo<Group[]>(() => {
    const byId = new Map(catalog.products.map((p) => [p.id, p]));
    const variantsOf = new Map<string, PosProduct[]>();
    for (const p of catalog.products) {
      if (p.parentId && byId.has(p.parentId)) {
        const arr = variantsOf.get(p.parentId) ?? [];
        arr.push(p);
        variantsOf.set(p.parentId, arr);
      }
    }
    return catalog.products
      .filter((p) => !p.parentId || !byId.has(p.parentId))
      .map((p) => ({ main: p, variants: variantsOf.get(p.id) ?? [] }));
  }, [catalog.products]);

  const visible = useMemo(() => {
    return groups.filter((g) => {
      const all = [g.main, ...g.variants];
      if (q) return all.some((p) => matches(p, q));
      if (tab === "all") return true;
      if (tab === "fav") return all.some((p) => p.favorite);
      return all.some((p) => p.categoryId === tab);
    });
  }, [groups, q, tab]);

  const tabs = [
    ...(hasFavorites ? [{ id: "fav", name: "Favoritos" }] : []),
    { id: "all", name: "Todos" },
    ...catalog.categories.map((c) => ({ id: c.id, name: c.name })),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="relative">
        <Search
          size={18}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && q) {
              const first = visible[0];
              const target = first
                ? first.variants.length && !first.main.priceCents
                  ? first.variants[0]
                  : first.main
                : null;
              if (target) {
                onAdd(target);
                setQuery("");
              }
            }
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Buscar por nombre o SKU (F2)"
          aria-label="Buscar producto"
          className="input min-h-12 pl-10 pr-10 text-base"
          autoComplete="off"
          enterKeyHint="done"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full hover:bg-black/5"
            aria-label="Limpiar búsqueda"
          >
            <X size={18} />
          </button>
        )}
      </div>
      <div
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
        role="tablist"
        aria-label="Categorías"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={!q && tab === t.id}
            onClick={() => {
              setTab(t.id);
              setQuery("");
            }}
            className={`pill flex min-h-11 shrink-0 items-center gap-1.5 px-4 text-sm font-semibold transition ${
              !q && tab === t.id
                ? "bg-teal text-white"
                : "bg-white text-ink shadow-card hover:bg-black/5"
            }`}
          >
            {t.id === "fav" && <Star size={14} />}
            {t.name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-24 lg:pb-2">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Sin productos que coincidan.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visible.map((g) => (
              <ProductCard
                key={g.main.id}
                group={g}
                onAdd={onAdd}
                allowNegative={allowNegativeStock}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProductCard({
  group,
  onAdd,
  allowNegative,
}: {
  group: Group;
  onAdd: (p: PosProduct) => void;
  allowNegative: boolean;
}) {
  const { main, variants } = group;
  const sellable = main.priceCents !== null;
  const title =
    main.parentId && main.variantLabel ? `${main.name} · ${main.variantLabel}` : main.name;
  return (
    <div className="card flex flex-col gap-2 p-2.5">
      <button
        type="button"
        onClick={() => sellable && onAdd(main)}
        disabled={!sellable}
        aria-label={sellable ? `Agregar ${title}` : `${title}: sin precio`}
        className="flex min-h-11 flex-col gap-2 rounded-[10px] text-left transition active:scale-[0.98] disabled:opacity-60"
      >
        <Thumb p={main} />
        <div className="flex items-start justify-between gap-1">
          <span className="line-clamp-2 text-sm font-semibold leading-tight">{title}</span>
          {main.favorite && (
            <Star size={14} className="mt-0.5 shrink-0 text-amber" aria-label="Favorito" />
          )}
        </div>
        <div className="flex items-center justify-between gap-1">
          <span className="text-base font-semibold tabular-nums text-teal-deep">
            {sellable
              ? formatMXN(main.priceCents!, { compact: true })
              : variants.length
                ? ""
                : "Sin precio"}
          </span>
          <StockBadge p={main} allowNegative={allowNegative} />
        </div>
      </button>
      {variants.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Variantes de ${main.name}`}>
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              disabled={v.priceCents === null}
              onClick={() => onAdd(v)}
              aria-label={`Agregar ${main.name} ${v.variantLabel}`}
              className={`pill flex min-h-11 items-center gap-1.5 px-3 text-sm font-medium transition active:scale-95 disabled:opacity-50 ${
                v.level === "out" && v.trackStock ? "st-amber" : "bg-black/5 hover:bg-black/10"
              }`}
            >
              {v.variantLabel}
              {v.priceCents !== null && (
                <span className="text-xs tabular-nums text-muted">
                  {formatMXN(v.priceCents, { compact: true })}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
