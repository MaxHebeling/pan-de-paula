"use client";

import type { CartChange } from "@/lib/cart/reconcile";

/**
 * Aviso de carrito actualizado: qué cambió y qué hicimos con el carrito.
 * `tone="alert"` (role="alert") cuando el cambio ocurrió justo al confirmar y el cliente debe volver a enviar;
 * en la carga de la página basta `role="status"`.
 */
export function CartNotice({
  changes,
  tone = "status",
  footer,
  onDismiss,
  testId = "cart-changes",
  className = "",
}: {
  changes: CartChange[];
  tone?: "status" | "alert";
  footer?: string | null;
  onDismiss?: () => void;
  testId?: string;
  className?: string;
}) {
  if (changes.length === 0) return null;
  return (
    <div
      role={tone === "alert" ? "alert" : "status"}
      data-testid={testId}
      className={`card flex items-start gap-3 border-crust/40 bg-crust/10 p-4 sm:p-5 ${className}`}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="mt-0.5 shrink-0 text-crust"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.01" />
      </svg>
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg text-ink">Actualizamos tu carrito</p>
        <ul className="mt-1.5 space-y-1 text-sm text-ink-2">
          {changes.map((c) => (
            <li key={`${c.kind}:${c.productId}`} data-testid="cart-change">
              {c.message}
            </li>
          ))}
        </ul>
        {footer && <p className="mt-2 text-sm font-medium text-ink">{footer}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="tap -mt-1 -mr-2 shrink-0 rounded-full text-ink-2 transition hover:bg-cream-2 hover:text-ink"
          aria-label="Ocultar aviso"
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
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
