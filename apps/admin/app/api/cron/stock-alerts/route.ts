import { NextResponse, type NextRequest } from "next/server";
import { db, sql, callFn } from "@/lib/db";

export const dynamic = "force-dynamic";

const JOB = "stock-alerts";
const STALE_MINUTES = 10;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

/**
 * Cron de alertas de stock: crea notificaciones de stock bajo/agotado e insumos críticos sin duplicar
 * las abiertas (run_stock_alerts) y registra la ejecución en job_runs con lock por lock_key.
 */
async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const d = db();
  // Libera locks huérfanos (proceso muerto sin cerrar el job)
  await sql`update job_runs set status = 'failed', finished_at = now(), error = 'lock expirado'
            where job_name = ${JOB} and status = 'running' and started_at < now() - (${STALE_MINUTES} || ' minutes')::interval`.execute(
    d,
  );
  let runId: string;
  try {
    const r = await sql<{ id: string }>`
      insert into job_runs(job_name, status, lock_key) values (${JOB}, 'running', ${JOB}) returning id`.execute(d);
    runId = r.rows[0]!.id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ ok: true, skipped: true, reason: "ya hay una ejecución en curso" }, { status: 200 });
    }
    console.error("[cron stock-alerts] no se pudo registrar job_run", e);
    return NextResponse.json({ ok: false, error: "No se pudo iniciar el job" }, { status: 500 });
  }
  try {
    const result = await callFn<Record<string, number>>(d, "run_stock_alerts", []);
    await sql`update job_runs set status = 'succeeded', finished_at = now(), result = ${JSON.stringify(result)}::jsonb where id = ${runId}`.execute(
      d,
    );
    return NextResponse.json({ ok: true, run_id: runId, result });
  } catch (e) {
    const message = (e as Error).message ?? "error desconocido";
    console.error("[cron stock-alerts] falló", e);
    await sql`update job_runs set status = 'failed', finished_at = now(), error = ${message} where id = ${runId}`.execute(d);
    return NextResponse.json({ ok: false, run_id: runId, error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
