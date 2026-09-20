import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/portal/session";
import { portalPulse } from "@/lib/portal/orders";

/**
 * "¿Cambió algo?" del portal: estado de cada pedido del cliente y cuántos avisos tiene sin leer.
 *
 * Por qué un sondeo corto y no Supabase Realtime: esta app habla con Postgres con su propio rol por
 * el pooler en modo transacción y el portal tiene sesión propia (cookie), no Supabase Auth. Realtime
 * exigiría exponer la clave anónima en el navegador y atar las políticas a usuarios de Supabase, es
 * decir, un segundo sistema de identidad y una superficie pública que este proyecto cierra a
 * propósito (migración 0080). El mismo patrón —sondear un endpoint propio— ya se usa para el
 * contador de pedidos sin ver del CRM.
 *
 * La respuesta solo contiene pedidos del cliente de la SESIÓN: no recibe nada de nadie más.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pulse = await portalPulse(session.customer.id);
  return NextResponse.json(pulse, {
    headers: { "cache-control": "no-store" },
  });
}
