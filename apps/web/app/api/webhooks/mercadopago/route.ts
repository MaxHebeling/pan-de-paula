import { NextResponse } from "next/server";
import {
  createLogger,
  parseMercadoPagoWebhook,
  verifyMercadoPagoSignature,
} from "@pdp/integrations";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processMercadoPagoEvent, recordMercadoPagoEvent } from "@/lib/webhooks/mercadopago";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 20; // MP corta a los 22 s

const log = createLogger("webhook.mercadopago.route");

/** Mercado Pago valida la URL con GET al configurarla. */
export function GET() {
  return NextResponse.json({ ok: true, provider: "mercadopago" });
}

/**
 * Notificaciones de Mercado Pago (evento `payment`).
 * 200 = recibido/procesado/duplicado/ignorado · 401 = firma inválida · 500 = error transitorio (MP reintenta).
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const n = parseMercadoPagoWebhook({ url: req.url, rawBody, headers: req.headers });
  const { MERCADOPAGO_WEBHOOK_SECRET: secret, APP_ENV } = env();

  let signatureValid: boolean | null;
  if (!secret) {
    if (APP_ENV === "production") {
      log.error("MERCADOPAGO_WEBHOOK_SECRET no configurado en producción: notificación rechazada");
      return NextResponse.json({ error: "webhook no configurado" }, { status: 500 });
    }
    log.warn("MERCADOPAGO_WEBHOOK_SECRET ausente: se acepta sin verificar (solo development)", {
      env: APP_ENV,
    });
    signatureValid = null;
  } else {
    signatureValid = verifyMercadoPagoSignature({
      xSignature: n.xSignature,
      xRequestId: n.xRequestId,
      dataId: n.dataId,
      secret,
    });
    if (!signatureValid) {
      log.warn("firma x-signature inválida", {
        dataId: n.dataId,
        type: n.type,
        requestId: n.xRequestId,
      });
      return NextResponse.json({ error: "firma inválida" }, { status: 401 });
    }
  }

  if (!n.dataId) {
    log.warn("notificación sin data.id; se ignora", { type: n.type, action: n.action });
    return NextResponse.json({ ok: true, ignored: true, reason: "sin data.id" });
  }

  const event = await recordMercadoPagoEvent(db(), n, signatureValid);
  if (!event.isNew && (event.status === "processed" || event.status === "ignored")) {
    return NextResponse.json({ ok: true, duplicate: true, status: event.status });
  }

  // received/failed → se procesa; processing → solo si quedó huérfano (la función anterior murió); si otro
  // proceso lo tiene en curso, el claim falla y respondemos duplicado (MP no debe reintentar).
  const result = await processMercadoPagoEvent(db(), event.id);
  if (result.status === "ignored" && result.reason === "not_claimable") {
    return NextResponse.json({ ok: true, duplicate: true, status: "processing" });
  }
  if (result.status === "failed") {
    return NextResponse.json({ ok: false, status: "failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, status: result.status });
}
