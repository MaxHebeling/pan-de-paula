import { NextResponse } from "next/server";
import { dbHealth } from "@pdp/db";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Readiness: base de datos accesible y migrada. Nunca 500: si falta configuración responde 503 con el motivo. */
export async function GET() {
  try {
    const health = await dbHealth(db());
    return NextResponse.json(
      { ok: health.ok, app: "web", db: health, time: new Date().toISOString() },
      { status: health.ok ? 200 : 503 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "error desconocido";
    console.error("[ready] no listo:", message);
    return NextResponse.json(
      { ok: false, app: "web", error: message, time: new Date().toISOString() },
      { status: 503 },
    );
  }
}
