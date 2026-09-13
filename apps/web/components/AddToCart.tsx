"use client";

import { useEffect, useRef, useState } from "react";
import { useCart } from "@/lib/cart/CartProvider";
import { MAX_QTY, type CartLine } from "@/lib/cart/types";
import { flyToCart, nudgeCard } from "@/lib/motion/productCards";

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
  const out = useRef<HTMLOutputElement>(null);
  const first = useRef(true);
  // Microfeedback: el número "late" al cambiar (sin remontar el aria-live).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = out.current;
    if (!el) return;
    el.classList.remove("qty-pop");
    void el.offsetWidth;
    el.classList.add("qty-pop");
    const off = () => el.classList.remove("qty-pop");
    el.addEventListener("animationend", off, { once: true });
    return () => el.removeEventListener("animationend", off);
  }, [value]);
  return (
    <div
      className="inline-flex items-center gap-1 rounded-pill border border-line bg-paper p-0.5"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className={`${btn} inline-flex items-center justify-center rounded-full text-ink transition hover:bg-cream-2 active:scale-95 disabled:opacity-40`}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label="Quitar uno"
      >
        −
      </button>
      <output
        ref={out}
        className="inline-block min-w-8 text-center text-base font-semibold tabular-nums"
        aria-live="polite"
      >
        {value}
      </output>
      <button
        type="button"
        className={`${btn} inline-flex items-center justify-center rounded-full text-ink transition hover:bg-cream-2 active:scale-95 disabled:opacity-40`}
        onClick={() => onChange(Math.min(MAX_QTY, value + 1))}
        disabled={value >= MAX_QTY}
        aria-label="Agregar uno"
      >
        +
      </button>
    </div>
  );
}

function Check() {
  return (
    <svg
      className="check-in"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
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
  const btn = useRef<HTMLButtonElement>(null);

  /**
   * Secuencia "Agregar" (300–600 ms): el botón confirma, el producto hace un micro-movimiento,
   * un punto vuela al icono del carrito (cuyo contador reacciona) y entonces se abre el cajón.
   * Con reduced motion o sin destino visible, el cajón se abre de inmediato como antes.
   */
  const add = () => {
    const el = btn.current;
    cart.add(product, qty, { open: false });
    setJustAdded(true);
    nudgeCard(el);
    void flyToCart(el).then(() => cart.open());
    window.setTimeout(() => setJustAdded(false), 1400);
  };

  if (compact) {
    return (
      <button
        ref={btn}
        type="button"
        onClick={add}
        disabled={disabled}
        className="btn btn-primary tap px-4"
        aria-label={`Agregar ${product.name} al carrito`}
        data-testid="add-compact"
      >
        {justAdded ? (
          <>
            Agregado <Check />
          </>
        ) : (
          "Agregar"
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {withStepper && <QuantityStepper value={qty} onChange={setQty} label="Cantidad" />}
      <button
        ref={btn}
        type="button"
        onClick={add}
        disabled={disabled}
        className="btn btn-primary btn-lg flex-1 sm:flex-none"
        data-testid="add-to-cart"
      >
        {justAdded ? (
          <>
            Agregado al carrito <Check />
          </>
        ) : (
          "Agregar al carrito"
        )}
      </button>
    </div>
  );
}
