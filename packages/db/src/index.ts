/**
 * @pdp/db — acceso tipado a Postgres con Kysely.
 * Los tipos en src/generated/db.d.ts se generan desde la base (pnpm db:codegen).
 */
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./generated/db.ts";

export type { DB } from "./generated/db.ts";
export type * from "./generated/db.ts";
export { sql } from "kysely";
export type { Kysely, Transaction } from "kysely";

export type Database = Kysely<DB>;

// NUMERIC llega como string por defecto; lo dejamos así (exactitud) salvo int8 que convertimos a number con guardas.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 fuera de rango seguro: ${v}`);
  return n;
});

export type DbOptions = {
  connectionString?: string;
  ssl?: boolean | "no-verify";
  max?: number;
};

function sslFromEnv(): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL ?? "disable").toLowerCase();
  if (mode === "disable" || mode === "false" || mode === "") return false;
  return { rejectUnauthorized: mode !== "no-verify" };
}

let singleton: { db: Database; pool: pg.Pool } | null = null;

/** Crea una instancia de Kysely con su pool. Úsala una vez por proceso (ver getDb). */
export function createDb(opts: DbOptions = {}): { db: Database; pool: pg.Pool } {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Falta DATABASE_URL");
  const pool = new pg.Pool({
    connectionString,
    ssl:
      opts.ssl === undefined
        ? sslFromEnv()
        : opts.ssl === "no-verify"
          ? { rejectUnauthorized: false }
          : opts.ssl
            ? { rejectUnauthorized: true }
            : false,
    max: opts.max ?? (process.env.VERCEL ? 3 : 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
  });
  pool.on("error", (err) => {
    console.error("[db] error en pool", err.message);
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}

/** Instancia compartida por proceso (serverless-friendly). */
export function getDb(): Database {
  if (!singleton) {
    const g = globalThis as unknown as { __pdp_db?: { db: Database; pool: pg.Pool } };
    singleton = g.__pdp_db ?? createDb();
    if (process.env.NODE_ENV !== "production") g.__pdp_db = singleton;
  }
  return singleton.db;
}

/**
 * Ejecuta `fn` dentro de una transacción con la identidad del staff fijada para auditoría.
 * Todas las funciones SQL de negocio leen current_staff_id().
 */
export async function withStaff<T>(
  db: Database,
  staffId: string | null,
  fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    if (staffId) {
      await sql`select set_config('app.staff_id', ${staffId}, true)`.execute(trx);
    }
    return fn(trx);
  });
}

/** Llama una función SQL que devuelve jsonb/escalar. */
export async function callFn<T = unknown>(
  exec: Database | Transaction<DB>,
  name: string,
  args: unknown[],
): Promise<T> {
  const placeholders = args.map((a) => sql`${a}`);
  const q = sql<{ result: T }>`select ${sql.raw(name)}(${sql.join(placeholders)}) as result`;
  const r = await q.execute(exec);
  return r.rows[0]!.result;
}

/** Comprobación de salud: conectividad + migraciones aplicadas. */
export async function dbHealth(
  db: Database,
): Promise<{ ok: boolean; latencyMs: number; migrations: number; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(
      db,
    );
    return { ok: true, latencyMs: Date.now() - t0, migrations: r.rows[0]?.n ?? 0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, migrations: 0, error: (e as Error).message };
  }
}

/** Traduce errores de Postgres a mensajes de negocio seguros para UI. */
export function dbErrorMessage(e: unknown): { message: string; code?: string } {
  const err = e as { code?: string; message?: string; detail?: string };
  if (!err || typeof err !== "object") return { message: "Error desconocido" };
  switch (err.code) {
    case "23505":
      return { message: "Ya existe un registro con esos datos", code: err.code };
    case "23503":
      return { message: "Referencia inválida o registro en uso", code: err.code };
    case "23514":
    case "P0001":
      return { message: err.message ?? "Operación no permitida", code: err.code };
    case "57014":
      return { message: "La operación tardó demasiado", code: err.code };
    default:
      return { message: err.message ?? "Error de base de datos", code: err.code };
  }
}
