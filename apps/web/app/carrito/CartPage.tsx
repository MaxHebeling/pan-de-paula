"use client";

import Link from "next/link";
import { useState } from "react";
import { QuantityStepper } from "@/components/AddToCart";
import { ProductArt } from "@/components/ProductArt";
import { useCart } from "@/lib/cart/CartProvider";
import { money } from "@/lib/format";

export function CartPage() {
  const cart = useCart();
  const [code, setCode] = useState("");

  if (!cart.hydrated) {
    return (
      <div className="container-x py-14">
        <h1 className="display text-4xl">Tu carrito</h1>
        <p className="mt-4 text-ink-2">Cargando…</p>
      </div>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <div className="container-x py-14">
        <h1 className="display text-4xl">Tu carrito</h1>
        <div className="card mt-8 p-10 text-center">
          <p className="font-display text-2xl text-ink">Aún no hay pan aquí</p>
          <p className="mt-2 text-ink-2">Elige algo del menú y lo horneamos para tu fecha.</p>
          <Link href="/menu" className="btn btn-primary mt-6">
            Ver menú
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container-x py-10 sm:py-14">
      <h1 className="display text-4xl">Tu carrito</h1>
      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
        <ul className="card divide-y divide-line" data-testid="cart-lines">
          {cart.lines.map((l) => (
            <li key={l.productId} className="flex gap-4 p-4 sm:p-5">
              <div className="h-24 w-24 shrink-0 overflow-hidden rounded-[14px] bg-cream-2">
                {l.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ProductArt name={l.name} seed={l.slug} className="h-full w-full" />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link
                      href={`/producto/${l.slug}`}
                      className="font-display text-lg text-ink hover:text-sage"
                    >
                      {l.name}
                    </Link>
                    <p className="text-sm text-ink-2">{money(l.unitPriceCents)} c/u</p>
                  </div>
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
                <div className="mt-auto flex items-center justify-between gap-3">
                  <QuantityStepper
                    value={l.qty}
                    onChange={(q) => cart.setQty(l.productId, q)}
                    label={`Cantidad de ${l.name}`}
                  />
                  <span className="font-semibold tabular-nums">
                    {money(l.unitPriceCents * l.qty)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="card p-5">
            <h2 className="font-display text-xl text-ink">Resumen</h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-2">
                  Subtotal ({cart.count} {cart.count === 1 ? "pieza" : "piezas"})
                </dt>
                <dd className="tabular-nums">{money(cart.totals.subtotalCents)}</dd>
              </div>
              {cart.coupon && (
                <div className="flex justify-between text-sage">
                  <dt>Cupón {cart.coupon.code}</dt>
                  <dd className="tabular-nums">−{money(cart.totals.discountCents)}</dd>
                </div>
              )}
              <div className="flex justify-between border-t border-line pt-3 text-base font-semibold">
                <dt>Total estimado</dt>
                <dd className="tabular-nums" data-testid="cart-total">
                  {money(cart.totals.totalCents)}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-ink-2">
              El total final se calcula en el servidor al confirmar el pedido.
            </p>
            <Link
              href="/checkout"
              className="btn btn-primary btn-lg mt-5 w-full"
              data-testid="go-checkout"
            >
              Continuar al pedido
            </Link>
            <Link href="/menu" className="btn btn-ghost mt-2 w-full">
              Seguir viendo el menú
            </Link>
          </div>

          <form
            className="card p-5"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await cart.applyCoupon(code);
              if (ok) setCode("");
            }}
          >
            <label htmlFor="coupon" className="label">
              ¿Tienes un cupón?
            </label>
            {cart.coupon ? (
              <div className="flex items-center justify-between gap-3 rounded-[14px] bg-sage/10 px-4 py-3 text-sm">
                <span>
                  <strong>{cart.coupon.code}</strong> aplicado · −{money(cart.coupon.discountCents)}
                </span>
                <button type="button" className="text-wine underline" onClick={cart.removeCoupon}>
                  Quitar
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  id="coupon"
                  className="input uppercase"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="CÓDIGO"
                  autoComplete="off"
                  maxLength={40}
                />
                <button
                  type="submit"
                  className="btn btn-secondary shrink-0"
                  disabled={cart.couponBusy || !code.trim()}
                >
                  {cart.couponBusy ? "Validando…" : "Aplicar"}
                </button>
              </div>
            )}
            {cart.couponError && (
              <p className="error" role="alert">
                {cart.couponError}
              </p>
            )}
          </form>

          <div className="card p-5">
            <label htmlFor="notes" className="label">
              Notas para la panadería (opcional)
            </label>
            <textarea
              id="notes"
              className="input min-h-24 py-3"
              value={cart.notes}
              onChange={(e) => cart.setNotes(e.target.value)}
              maxLength={500}
              placeholder="Ej. sin nuez en el brownie, es para regalo…"
            />
            <p className="help">{cart.notes.length}/500</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
