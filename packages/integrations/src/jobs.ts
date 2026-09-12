/**
 * Ejecución de jobs (cron) con registro en `job_runs` y lock para evitar concurrencia.
 * - `lock_key` + índice único parcial (status = 'running') garantizan una sola ejecución activa por job.
 * - Si otro proceso tiene el lock, se registra `skipped` y no se ejecuta.
 * - Locks colgados (proceso muerto) se liberan tras `staleAfterMs` (default 15 min).
 */
import { sql, type Database } from "@pdp/db";
import { createLogger } from "./logger.ts";

const log = createLogger("jobs");

export type JobOutcome<T> =
  | { status: "succeeded"; runId: string; result: T; durationMs: number }
  | { status: "skipped"; runId: string | null; reason: string }
  | { status: "failed"; runId: string; error: string; durationMs: number };

export type RunJobOptions = {
  /** Clave de lock; por defecto el nombre del job. */
  lockKey?: string;
  /** Un run 'running' más viejo que esto se considera muerto y se marca failed. */
  staleAfterMs?: number;
};

/**
 * Ejecuta `fn` una sola vez a la vez por `name`, registrando inicio/fin/resultado/error en `job_runs`.
 * Nunca lanza por el lock: devuelve `skipped`. Los errores de `fn` se registran y se devuelven como `failed`.
 */
export async function runJob<T>(
  db: Database,
  name: string,
  fn: (db: Database) => Promise<T>,
  opts: RunJobOptions = {},
): Promise<JobOutcome<T>> {
  const lockKey = opts.lockKey ?? name;
  const staleMs = opts.staleAfterMs ?? 15 * 60_000;

  // Libera locks colgados
  await sql`
    update job_runs set status = 'failed', finished_at = now(), error = 'lock expirado (proceso sin respuesta)'
    where lock_key = ${lockKey} and status = 'running' and started_at < now() - make_interval(secs => ${staleMs / 1000})
  `.execute(db);

  let runId: string;
  try {
    const r = await sql<{ id: string }>`
      insert into job_runs(job_name, status, lock_key) values (${name}, 'running', ${lockKey}) returning id
    `.execute(db);
    runId = r.rows[0]!.id;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      await sql`insert into job_runs(job_name, status, finished_at, result) values (${name}, 'skipped', now(), ${JSON.stringify({ reason: "locked" })}::jsonb)`.execute(
        db,
      );
      log.info("job omitido: ya hay una ejecución en curso", { job: name });
      return { status: "skipped", runId: null, reason: "locked" };
    }
    throw e;
  }

  const t0 = Date.now();
  try {
    const result = await fn(db);
    const durationMs = Date.now() - t0;
    await sql`update job_runs set status = 'succeeded', finished_at = now(), result = ${JSON.stringify(result ?? null)}::jsonb where id = ${runId}`.execute(
      db,
    );
    log.info("job terminado", { job: name, durationMs, result });
    return { status: "succeeded", runId, result, durationMs };
  } catch (e) {
    const durationMs = Date.now() - t0;
    const message = e instanceof Error ? e.message : String(e);
    await sql`update job_runs set status = 'failed', finished_at = now(), error = ${message.slice(0, 2000)} where id = ${runId}`
      .execute(db)
      .catch((err) => log.error("no se pudo registrar el fallo del job", { job: name, err }));
    log.error("job falló", { job: name, durationMs, err: e });
    return { status: "failed", runId, error: message, durationMs };
  }
}

/** Autoriza una petición de cron: `Authorization: Bearer <CRON_SECRET>`. Sin secreto configurado → rechaza. */
export function isCronAuthorized(
  authorizationHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || secret.length < 16) return false;
  if (!authorizationHeader) return false;
  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme !== "Bearer" || !token) return false;
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
