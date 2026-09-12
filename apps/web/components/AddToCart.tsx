"use client";

import { useState } from "react";
import { useCart } from "@/lib/cart/CartProvider";
import { MAX_QTY, type CartLine } from "@/lib/cart/types";

type Product = Omit<CartLine, "qty">;

export function QuantityStepper({
  value,
  onChange,
  label,
  min = 1,
  size = "md",
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  size?: "sm" | "md";
}) {
  const btn = size === "sm" ? "h-10 w-10 text-base" : "h-11 w-11 text-lg";
  return (
    <div
      className="inline-flex items-center gap-1 rounded-pill border border-line bg-paper p-0.5"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className={`${btn} inline-flex items-center justify-center rounded-full text-ink transition hover:bg-cream-2 disabled:opacity-40`}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label="Quitar uno"
      >
        −
      </button>
      <output
        className="min-w-8 text-center text-base font-semibold tabular-nums"
        aria-live="polite"
      >
        {value}
      </output>
      <button
        type="button"
        className={`${btn} inline-flex items-center justify-center rounded-full text-ink transition hover:bg-cream-2 disabled:opacity-40`}
        onClick={() => onChange(Math.min(MAX_QTY, value + 1))}
        disabled={value >= MAX_QTY}
        aria-label="Agregar uno"
      >
        +
      </button>
    </div>
  );
}

export function AddToCart({
  product,
  disabled = false,
  withStepper = true,
  compact = false,
}: {
  product: Product;
  disabled?: boolean;
  withStepper?: boolean;
  compact?: boolean;
}) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const [justAdded, setJustAdded] = useState(false);

  const add = () => {
    cart.add(product, qty);
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1400);
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="btn btn-primary tap px-4"
        aria-label={`Agregar ${product.name} al carrito`}
        data-testid="add-compact"
      >
        {justAdded ? "Agregado ✓" : "Agregar"}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {withStepper && <QuantityStepper value={qty} onChange={setQty} label="Cantidad" />}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className={`btn btn-primary btn-lg flex-1 sm:flex-none ${justAdded ? "pop" : ""}`}
        data-testid="add-to-cart"
      >
        {justAdded ? "Agregado al carrito ✓" : "Agregar al carrito"}
      </button>
    </div>
  );
}
