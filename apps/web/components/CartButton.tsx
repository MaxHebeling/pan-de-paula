"use client";

import { useCart } from "@/lib/cart/CartProvider";

export function CartButton() {
  const cart = useCart();
  return (
    <button
      type="button"
      onClick={cart.open}
      className="tap relative inline-flex items-center justify-center rounded-full text-ink transition hover:bg-cream-2"
      aria-label={`Abrir carrito, ${cart.count} ${cart.count === 1 ? "artículo" : "artículos"}`}
      data-testid="cart-button"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M6 7h12l1.2 12.1a1 1 0 0 1-1 1.1H5.8a1 1 0 0 1-1-1.1L6 7Z" />
        <path d="M9 10V6a3 3 0 0 1 6 0v4" />
      </svg>
      {cart.hydrated && cart.count > 0 && (
        // La key cambia con cada "agregar": el badge se remonta y reproduce la animación sin estado extra.
        <span
          key={cart.lastAddedAt}
          className={`absolute -top-0.5 -right-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-wine px-1 text-[11px] font-bold text-white ${cart.lastAddedAt ? "pop" : ""}`}
          data-testid="cart-count"
        >
          {cart.count}
        </span>
      )}
    </button>
  );
}
