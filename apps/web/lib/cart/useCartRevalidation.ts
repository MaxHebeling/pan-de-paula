"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { revalidateCartAction } from "@/app/carrito/actions";
import { useCart } from "./CartProvider";
import { reconcileCart, type CartChange } from "./reconcile";
import { cartStore, getSnapshot } from "./store";

export type CartRevalidation = {
  /** Cambios detectados en la última revalidación (vacío si el carrito estaba al día). */
  changes: CartChange[];
  checking: boolean;
  /** Revalida contra el servidor y corrige el carrito. Devuelve `true` si algo cambió. */
  check: () => Promise<boolean>;
  dismiss: () => void;
};

/**
 * Revalida el carrito guardado contra los precios y la disponibilidad del servidor.
 * Una sola llamada al cargar la página (sin sondeos) y otra a petición, antes de enviar el pedido.
 * Si el servidor no responde no se toca el carrito: `create_order` vuelve a calcular todo al confirmar.
 */
export function useCartRevalidation(): CartRevalidation {
  const { hydrated } = useCart();
  const [changes, setChanges] = useState<CartChange[]>([]);
  const [checking, setChecking] = useState(false);
  const inflight = useRef<Promise<boolean> | null>(null);

  const check = useCallback(async (): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    const current = getSnapshot();
    if (current.lines.length === 0) return false;
    setChecking(true);
    const run = (async () => {
      try {
        const r = await revalidateCartAction(
          current.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
        );
        if (!r.ok) return false;
        const result = reconcileCart(getSnapshot().lines, r.products);
        if (result.changes.length === 0) return false;
        cartStore.replaceLines(result.lines);
        setChanges(result.changes);
        return true;
      } catch (e) {
        console.error("[cart] no se pudo revalidar el carrito", e);
        return false;
      } finally {
        inflight.current = null;
        setChecking(false);
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  const once = useRef(false);
  useEffect(() => {
    if (!hydrated || once.current) return;
    once.current = true;
    void check();
  }, [hydrated, check]);

  return { changes, checking, check, dismiss: () => setChanges([]) };
}
