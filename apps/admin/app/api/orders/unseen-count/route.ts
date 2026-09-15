import { NextResponse } from "next/server";
import { getSession, hasPermission } from "@/lib/auth";
import { countUnseenOrders } from "@/lib/orders-unseen";

export const dynamic = "force-dynamic";

/** GET /api/orders/unseen-count — contador del sidebar (pedidos que nadie ha abierto). */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!hasPermission(session, "orders.read"))
    return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
  return NextResponse.json(
    { unseen: await countUnseenOrders() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
