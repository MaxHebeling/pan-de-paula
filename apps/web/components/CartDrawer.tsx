"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useCart } from "@/lib/cart/CartProvider";
import { money } from "@/lib/format";
import { QuantityStepper } from "./AddToCart";
import { ProductArt } from "./ProductArt";

export function CartDrawer() {
  const cart = useCart();
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!cart.isOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cart.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [cart.isOpen, cart]);

  if (!cart.isOpen) return null;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-ink/40"
        aria-label="Cerrar carrito"
        onClick={cart.close}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-title"
        className="drawer-in absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-paper shadow-lift"
        data-testid="cart-drawer"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="cart-title" className="font-display text-xl text-ink">
            Tu carrito
          </h2>
          <button
            ref={closeBtn}
            type="button"
            onClick={cart.close}
            className="tap rounded-full text-ink hover:bg-cream-2"
            aria-label="Cerrar"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {cart.lines.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
            <p className="font-display text-2xl text-ink">Aún no hay pan aquí</p>
            <p className="text-sm text-ink-2">Elige algo del menú y lo horneamos para tu fecha.</p>
            <Link href="/menu" className="btn btn-primary" onClick={cart.close}>
              Ver menú
            </Link>
          </div>
        ) : (
          <>
            <ul className="flex-1 divide-y divide-line overflow-y-auto px-5">
              {cart.lines.map((l) => (
                <li key={l.productId} className="flex gap-3 py-4">
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-[14px] bg-cream-2">
                    {l.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={l.imageUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ProductArt name={l.name} seed={l.slug} className="h-full w-full" />
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/producto/${l.slug}`}
                        onClick={cart.close}
                        className="font-medium text-ink hover:text-sage"
                      >
                        {l.name}
                        {l.variantLabel && <span className="text-ink-2"> · {l.variantLabel}</span>}
                      </Link>
                      <button
                        type="button"
                        onClick={() => cart.remove(l.productId)}
                        className="tap -mr-2 shrink-0 rounded-full text-ink-2 hover:bg-cream-2 hover:text-wine"
                        aria-label={`Quitar ${l.name}`}
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
                          <path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <QuantityStepper
                        size="sm"
                        value={l.qty}
                        onChange={(q) => cart.setQty(l.productId, q)}
                        label={`Cantidad de ${l.name}`}
                      />
                      <span className="text-sm font-semibold tabular-nums">
                        {money(l.unitPriceCents * l.qty)}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="space-y-3 border-t border-line px-5 py-4">
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink-2">Subtotal</dt>
                  <dd className="tabular-nums">{money(cart.totals.subtotalCents)}</dd>
                </div>
                {cart.coupon && (
                  <div className="flex justify-between text-sage">
                    <dt>Cupón {cart.coupon.code}</dt>
                    <dd className="tabular-nums">−{money(cart.totals.discountCents)}</dd>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tabular-nums" data-testid="drawer-total">
                    {money(cart.totals.totalCents)}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-ink-2">
                Los precios finales se confirman al hacer el pedido.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Link href="/carrito" className="btn btn-secondary" onClick={cart.close}>
                  Ver carrito
                </Link>
                <Link
                  href="/checkout"
                  className="btn btn-primary"
                  onClick={cart.close}
                  data-testid="drawer-checkout"
                >
                  Hacer pedido
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
