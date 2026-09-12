"use server";

import { redirect } from "next/navigation";
import { getOrderByFolio, mercadoPagoAvailable, orderUrl, startMercadoPago } from "@/lib/orders";
import { rateLimit } from "@/lib/rate-limit";
import { getBusiness } from "@/lib/site";

/** "Reintentar pago": crea una nueva preferencia de Mercado Pago para un pedido aún no pagado. */
export async function retryPaymentAction(formData: FormData) {
  const folio = String(formData.get("folio") ?? "");
  const token = String(formData.get("t") ?? "");
  const order = await getOrderByFolio(folio, token);
  if (!order) redirect("/");
  const rl = await rateLimit("retry-payment", { max: 10 });
  if (!rl.allowed) redirect(orderUrl(order.folio, order.publicToken, { mp: "ratelimit" }));
  const business = await getBusiness();
  const payable = ["new", "payment_pending"].includes(order.status) && ["pending", "failed"].includes(order.paymentStatus);
  if (!payable || !mercadoPagoAvailable(business.flags)) redirect(orderUrl(order.folio, order.publicToken));
  let url: string;
  try {
    url = await startMercadoPago(order, business);
  } catch (e) {
    console.error(`[retryPaymentAction] Mercado Pago falló para ${order.folio}`, e);
    redirect(orderUrl(order.folio, order.publicToken, { mp: "error" }));
  }
  redirect(url);
}
