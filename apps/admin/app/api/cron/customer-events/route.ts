import { NextResponse, type NextRequest } from "next/server";
import { db, sql, callFn } from "@/lib/db";

export const dynamic = "force-dynamic";

const JOB = "customer-events";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * Cron diario de eventos de cliente: cumpleaños, inactividad 30/60 días, aniversario de alta + notificaciones.
 * Idempotente (índice único diario en customer_events) y con lock en job_runs (una ejecución a la vez).
 * Auth: Authorization: Bearer $CRON_SECRET (Vercel Cron lo envía automáticamente).
 */
async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const d = db();
  let runId: string;
  try {
    const r = await sql<{ id: string }>`insert into job_runs(job_name, lock_key) values (${JOB}, ${JOB}) returning id`.execute(d);
    runId = r.rows[0]!.id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return NextResponse.json({ ok: false, skipped: "already_running" }, { status: 409 });
    console.error("[cron] no se pudo registrar job_run", (e as Error).message);
    return NextResponse.json({ error: "No se pudo iniciar el job" }, { status: 500 });
  }
  try {
    const result = await callFn<Record<string, unknown>>(d, "run_customer_events", [null]);
    await sql`update job_runs set status = 'succeeded', finished_at = now(), result = ${JSON.stringify(result)}::jsonb where id = ${runId}`.execute(d);
    return NextResponse.json({ ok: true, job: JOB, run_id: runId, result });
  } catch (e) {
    const message = (e as Error).message;
    console.error("[cron] customer-events falló", message);
    await sql`update job_runs set status = 'failed', finished_at = now(), error = ${message} where id = ${runId}`.execute(d);
    return NextResponse.json({ ok: false, job: JOB, run_id: runId, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
