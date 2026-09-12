"use client";

import { useState } from "react";
import { AddToCart } from "@/components/AddToCart";
import { Price } from "@/components/Price";
import { availability } from "@/lib/availability";
import type { CatalogProduct } from "@/lib/catalog";

/** Selector de variantes (productos hijos) + añadir al carrito. Si no hay variantes, usa el producto base. */
export function VariantPicker({
  base,
  variants,
}: {
  base: CatalogProduct;
  variants: CatalogProduct[];
}) {
  const options = variants.length > 0 ? variants : [base];
  const [selectedId, setSelectedId] = useState(options[0]!.id);
  const selected = options.find((o) => o.id === selectedId) ?? options[0]!;
  const av = availability(selected);
  return (
    <div className="space-y-5">
      {variants.length > 0 && (
        <fieldset>
          <legend className="label">Elige tu opción</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => {
              const vav = availability(v);
              return (
                <label
                  key={v.id}
                  className={`chip cursor-pointer ${v.id === selectedId ? "chip-active" : ""} ${!vav.canAdd ? "opacity-50" : ""}`}
                >
                  <input
                    type="radio"
                    name="variant"
                    value={v.id}
                    className="sr-only"
                    checked={v.id === selectedId}
                    onChange={() => setSelectedId(v.id)}
                  />
                  {v.variantLabel ?? v.name}
                  {v.priceCents !== null && (
                    <span className="ml-2 opacity-80">
                      {(v.priceCents / 100).toLocaleString("es-MX", {
                        style: "currency",
                        currency: "MXN",
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <div className="flex items-baseline gap-3">
        <Price cents={selected.priceCents} regularCents={selected.regularPriceCents} size="lg" />
        <span className="text-sm text-ink-2">por {selected.unitLabel}</span>
      </div>
      {av.note && <p className="text-sm text-ink-2">{av.note}</p>}
      {av.canAdd ? (
        <AddToCart
          product={{
            productId: selected.id,
            slug: base.slug,
            name:
              variants.length > 0
                ? `${base.name} · ${selected.variantLabel ?? selected.name}`
                : base.name,
            variantLabel: selected.variantLabel,
            unitPriceCents: selected.priceCents ?? 0,
            imageUrl: selected.primaryImageUrl ?? base.primaryImageUrl,
            categorySlug: base.categorySlug,
          }}
        />
      ) : (
        <p className="rounded-[14px] bg-cream-2 px-4 py-3 text-sm text-ink">
          Por ahora no está disponible para pedidos en línea.
        </p>
      )}
    </div>
  );
}
