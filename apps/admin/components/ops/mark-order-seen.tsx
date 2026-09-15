"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { markOrderSeenAction } from "@/app/(app)/pedidos/seen-actions";
import { ORDERS_UNSEEN_EVENT } from "@/components/orders-badge";

/** Al abrir el detalle registra la primera vista y actualiza el contador del sidebar al instante. */
export function MarkOrderSeen({ orderId }: { orderId: string }) {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    markOrderSeenAction(orderId)
      .then((r) => {
        if (!alive || !r.first) return;
        window.dispatchEvent(new Event(ORDERS_UNSEEN_EVENT));
        router.refresh();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orderId, router]);
  return null;
}
