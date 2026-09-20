import { NextResponse } from "next/server";
import { z } from "zod";
import { removeSubscription, saveSubscription } from "@pdp/integrations";
import { db } from "@/lib/db";
import { getCustomerSession } from "@/lib/portal/session";

/**
 * Alta y baja de la suscripción push de UN dispositivo.
 *
 * La suscripción siempre se guarda contra el cliente de la SESIÓN: el cuerpo de la petición no dice
 * de quién es, solo trae lo que el navegador entregó (endpoint y sus claves públicas). Así nadie
 * puede apuntar los avisos de otra persona a su propio teléfono.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const suscripcion = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(200) }),
});

export async function POST(req: Request) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = suscripcion.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await saveSubscription(db(), {
    customerId: session.customer.id,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    userAgent: req.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const endpoint = z
    .string()
    .url()
    .max(1000)
    .safeParse((body as { endpoint?: string })?.endpoint);
  if (!endpoint.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await removeSubscription(db(), session.customer.id, endpoint.data);
  return NextResponse.json({ ok: true });
}
