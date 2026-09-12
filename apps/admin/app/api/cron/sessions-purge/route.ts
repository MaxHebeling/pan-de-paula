import { NextResponse } from "next/server";
import { purgeExpiredSessions } from "@pdp/auth";
import { isCronAuthorized, runJob } from "@pdp/integrations";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Cron diario: elimina sesiones de staff expiradas/revocadas hace más de 30 días. */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), env().CRON_SECRET)) {
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }
  const outcome = await runJob(db(), "sessions-purge", async (d) => ({
    purged: await purgeExpiredSessions(d),
  }));
  return NextResponse.json(outcome, { status: outcome.status === "failed" ? 500 : 200 });
}

export const POST = GET;
