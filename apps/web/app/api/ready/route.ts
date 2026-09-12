import { NextResponse } from "next/server";
import { dbHealth } from "@pdp/db";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Readiness: base de datos accesible y migrada. */
export async function GET() {
  const health = await dbHealth(db());
  const status = health.ok ? 200 : 503;
  return NextResponse.json(
    { ok: health.ok, app: "web", db: health, time: new Date().toISOString() },
    { status },
  );
}
