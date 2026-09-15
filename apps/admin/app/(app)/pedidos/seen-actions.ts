"use server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { markOrderSeen } from "@/lib/orders-unseen";

/** Marca el pedido como visto al abrir su detalle (desde el cliente: un prefetch no cuenta como vista). */
export async function markOrderSeenAction(orderId: string): Promise<{ first: boolean }> {
  const session = await requireSession("orders.read");
  if (!z.string().uuid().safeParse(orderId).success) return { first: false };
  return { first: await markOrderSeen(orderId, session.staff.id) };
}
