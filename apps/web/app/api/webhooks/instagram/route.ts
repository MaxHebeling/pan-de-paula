import { NextResponse } from "next/server";
import {
  createLogger,
  parseInstagramWebhook,
  verifyMetaSignature,
  verifyMetaWebhookChallenge,
} from "@pdp/integrations";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processInstagramEvent } from "@/lib/webhooks/instagram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 25;

const log = createLogger("webhook.instagram.route");

/** Verificación del webhook por Meta: responde hub.challenge en texto plano. */
export function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const challenge = verifyMetaWebhookChallenge(searchParams, env().META_VERIFY_TOKEN);
  if (!challenge) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Eventos de mensajería. Firma X-Hub-Signature-256 obligatoria (salvo development sin secreto).
 * Se responde 200 en cuanto los eventos quedan registrados; los fallos del bot se guardan como `failed`.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const { META_APP_SECRET: secret, APP_ENV, NEXT_PUBLIC_SITE_URL } = env();
  let signatureValid: boolean | null;
  if (!secret) {
    if (APP_ENV === "production") {
      log.error("META_APP_SECRET no configurado en producción: evento rechazado");
      return NextResponse.json({ error: "webhook no configurado" }, { status: 500 });
    }
    log.warn("META_APP_SECRET ausente: se acepta sin verificar (solo development)");
    signatureValid = null;
  } else {
    signatureValid = verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"), secret);
    if (!signatureValid) {
      log.warn("firma X-Hub-Signature-256 inválida");
      return NextResponse.json({ error: "firma inválida" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const events = parseInstagramWebhook(body);
  const results: Array<{ status: string; reason?: string }> = [];
  for (const ev of events) {
    try {
      const r = await processInstagramEvent(db(), ev, {
        siteUrl: NEXT_PUBLIC_SITE_URL,
        signatureValid,
      });
      results.push({ status: r.status, reason: r.reason });
    } catch (e) {
      // Falló antes de registrar el evento (p. ej. DB caída): pedimos reintento a Meta.
      log.error("no se pudo registrar el evento de Instagram", { err: e });
      return NextResponse.json({ error: "error temporal" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, received: events.length, results });
}
