import { NextResponse } from "next/server";
import { isCronAuthorized, runJob } from "@pdp/integrations";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { retryPendingMercadoPagoEvents } from "@/lib/webhooks/mercadopago";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Cron (cada 15 min): reprocesa notificaciones de Mercado Pago pendientes/fallidas de las últimas 48 h.
 * Autenticación: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron lo envía automáticamente).
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), env().CRON_SECRET)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  const outcome = await runJob(db(), "webhooks-retry", (d) =>
    retryPendingMercadoPagoEvents(d, { limit: 50 }),
  );
  const status = outcome.status === "failed" ? 500 : 200;
  return NextResponse.json(outcome, { status });
}

export const POST = GET;
