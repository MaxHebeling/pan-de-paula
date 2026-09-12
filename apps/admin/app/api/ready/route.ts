import { NextResponse } from "next/server";
import { dbHealth } from "@pdp/db";
import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  const health = await dbHealth(db());
  return NextResponse.json(
    { ok: health.ok, app: "admin", db: health, time: new Date().toISOString() },
    { status: health.ok ? 200 : 503 },
  );
}
