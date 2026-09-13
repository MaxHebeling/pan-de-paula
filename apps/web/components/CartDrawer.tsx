"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { trapFocus } from "@/lib/a11y/focusTrap";
import { useCart } from "@/lib/cart/CartProvider";
import { money } from "@/lib/format";
import { motionEnabled } from "@/lib/motion/reducedMotion";
import { pauseSmoothScroll, resumeSmoothScroll } from "@/lib/motion/smoothScroll";
import { QuantityStepper } from "./AddToCart";
import { ProductArt } from "./ProductArt";

const CLOSE_MS = 300;
const REMOVE_MS = 180;

export function CartDrawer() {
  const cart = useCart();
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  // Presencia: al cerrar, el cajón sigue montado mientras sale (translateX + fade) y se desmonta al terminar.
  const [mounted, setMounted] = useState(cart.isOpen);
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(cart.isOpen);
  if (cart.isOpen !== prevOpen) {
    setPrevOpen(cart.isOpen);
    if (cart.isOpen) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      if (motionEnabled()) setClosing(true);
      else setMounted(false);
    }
  }
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(() => {
      setClosing(false);
      setMounted(false);
    }, CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [closing]);

  useEffect(() => {
    if (!cart.isOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    document.body.style.overflow = "hidden";
    pauseSmoothScroll();
    const untrap = panel.current ? trapFocus(panel.current) : () => {};
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cart.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      resumeSmoothScroll();
      untrap();
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [cart.isOpen, cart]);

  const removeLine = (e: React.MouseEvent<HTMLButtonElement>, productId: string) => {
    const li = e.currentTarget.closest<HTMLElement>("li");
    if (!motionEnabled() || !li || !("animate" in li)) {
      cart.remove(productId);
      return;
    }
    li.classList.add("is-removing");
    window.setTimeout(() => {
      const h = li.getBoundingClientRect().height;
      const anim = li.animate(
        [
          { height: `${h}px`, paddingTop: getComputedStyle(li).paddingTop },
          { height: "0px", paddingTop: "0px", paddingBottom: "0px" },
        ],
        { duration: 160, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "forwards" },
      );
      const done = () => cart.remove(productId);
      anim.addEventListener("finish", done, { once: true });
      anim.addEventListener("cancel", done, { once: true });
    }, REMOVE_MS);
  };

  if (!mounted) return null;

  return (
    <div className={`fixed inset-0 z-50 ${closing ? "drawer-closing" : ""}`} role="presentation">
      <button
        type="button"
        className="drawer-overlay absolute inset-0 bg-ink/40"
        aria-label="Cerrar carrito"
        onClick={cart.close}
        tabIndex={-1}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-title"
        className="drawer-in drawer-panel absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-paper shadow-lift"
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
            className="tap rounded-full text-ink transition hover:bg-cream-2"
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
            <ul className="flex-1 divide-y divide-line overflow-y-auto px-5" data-lenis-prevent>
              {cart.lines.map((l, i) => (
                <li
                  key={l.productId}
                  className="drawer-line flex gap-3 overflow-hidden py-4"
                  style={{ "--i": Math.min(i, 6) } as CSSProperties}
                >
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
                        className="font-medium text-ink transition-colors hover:text-sage"
                      >
                        {l.name}
                        {l.variantLabel && <span className="text-ink-2"> · {l.variantLabel}</span>}
                      </Link>
                      <button
                        type="button"
                        onClick={(e) => removeLine(e, l.productId)}
                        className="tap -mr-2 shrink-0 rounded-full text-ink-2 transition hover:bg-cream-2 hover:text-wine"
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
                  <svg
                    className="btn-icon"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
