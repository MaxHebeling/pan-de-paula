"use client";
import { useCallback, useEffect, useState } from "react";

/** Evento local: alguien abrió un pedido en esta pestaña → recontar sin esperar al siguiente sondeo. */
export const ORDERS_UNSEEN_EVENT = "pdp:orders-unseen-changed";
const POLL_MS = 30_000;

/**
 * Contador de pedidos sin ver. Parte del valor del servidor y se mantiene al día sondeando cada 30 s con la
 * pestaña visible, al volver a la pestaña y cuando se abre un pedido. `enabled=false` (sin permiso) no consulta.
 */
export function useUnseenOrders(initial: number, enabled: boolean): number {
  const [count, setCount] = useState(initial);
  // Si el servidor trae un valor nuevo (navegación o router.refresh), manda sobre el último sondeo.
  const [base, setBase] = useState(initial);
  if (base !== initial) {
    setBase(initial);
    setCount(initial);
  }

  const refresh = useCallback(async () => {
    if (!enabled || document.visibilityState !== "visible") return;
    try {
      const res = await fetch("/api/orders/unseen-count", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { unseen?: unknown };
      if (typeof body.unseen === "number") setCount(body.unseen);
    } catch {
      // Sin red: se conserva el último valor conocido.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(refresh, POLL_MS);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(ORDERS_UNSEEN_EVENT, onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(ORDERS_UNSEEN_EVENT, onVisible);
    };
  }, [enabled, refresh]);

  return enabled ? count : 0;
}

/** Píldora del contador junto a una entrada del menú (en la entrada activa se invierte a blanco sobre teal). */
export function CountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="orders-unseen-badge"
      aria-label={label}
      className="ml-auto min-w-5 rounded-full bg-red px-1.5 text-center text-[11px] font-bold leading-5 text-white group-aria-[current=page]:bg-white group-aria-[current=page]:text-teal"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
