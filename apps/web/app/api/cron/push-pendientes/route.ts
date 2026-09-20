import { NextResponse } from "next/server";
import { deliverPendingPushes, isCronAuthorized, runJob } from "@pdp/integrations";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * Red de seguridad del push (cada 15 min).
 *
 * El camino normal es inmediato: el CRM mueve el estado y en el acto entrega los avisos de ese
 * pedido. Este cron recoge lo que no pasó por ahí —un pago confirmado por webhook, un despliegue a
 * medias— y solo mira avisos de la última hora: un pedido de ayer ya no es noticia que despertar.
 * Como el envío se RECLAMA con `pushed_at`, coincidir con la acción del CRM no manda nada dos veces.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), env().CRON_SECRET)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  const outcome = await runJob(db(), "push-pendientes", async (d) => deliverPendingPushes(d));
  return NextResponse.json(outcome, { status: outcome.status === "failed" ? 500 : 200 });
}

export const POST = GET;
