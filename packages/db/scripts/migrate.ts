/**
 * Runner de migraciones SQL.
 * - Cada archivo migrations/NNNN_nombre.sql se aplica una sola vez, dentro de una transacción.
 * - Registra checksum: si un archivo ya aplicado cambia, falla (las migraciones son inmutables).
 * - Usa advisory lock para que dos deploys no migren a la vez.
 * Uso: tsx scripts/migrate.ts [--status] [--url postgres://...]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { databaseUrl, sslConfig } from "./env.ts";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../migrations");
const LOCK_KEY = 7_204_010; // arbitrario, fijo

export type MigrationFile = {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
};

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(resolve(dir, f), "utf8");
      return {
        version: f.slice(0, 4),
        name: f,
        path: resolve(dir, f),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

export async function migrate(
  url: string,
  opts: { statusOnly?: boolean; log?: (m: string) => void } = {},
) {
  const log = opts.log ?? ((m: string) => console.info(m));
  const client = new pg.Client({ connectionString: url, ssl: sslConfig() });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now(), duration_ms integer)`);
    const applied = new Map<string, { checksum: string; name: string }>();
    for (const r of (await client.query("select version, name, checksum from schema_migrations"))
      .rows) {
      applied.set(r.version, { checksum: r.checksum, name: r.name });
    }
    const files = listMigrations();
    const versions = files.map((f) => f.version);
    if (new Set(versions).size !== versions.length)
      throw new Error("Versiones de migración duplicadas: " + versions.join(","));

    let pending = 0;
    for (const f of files) {
      const a = applied.get(f.version);
      if (a && a.checksum !== f.checksum) {
        throw new Error(
          `La migración ${f.name} ya fue aplicada con otro contenido. Las migraciones son inmutables: crea una nueva.`,
        );
      }
      if (!a) pending++;
    }
    const maxApplied = [...applied.keys()].sort().at(-1);
    const outOfOrder = files.filter(
      (f) => !applied.has(f.version) && maxApplied && f.version < maxApplied,
    );
    if (outOfOrder.length) {
      log(
        `⚠ ${outOfOrder.length} migración(es) con número menor a la última aplicada (${maxApplied}) se aplicarán ahora: ${outOfOrder
          .map((f) => f.name)
          .join(", ")}. Asegúrate de que no dependan de cambios posteriores.`,
      );
    }
    if (opts.statusOnly) {
      for (const f of files) log(`${applied.has(f.version) ? "✔" : "·"} ${f.name}`);
      log(`${pending} pendiente(s)`);
      return { applied: 0, pending };
    }
    if (pending === 0) {
      await runPostMigrate(client, log);
      log("Base de datos al día (0 migraciones pendientes)");
      return { applied: 0, pending: 0 };
    }
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    let count = 0;
    try {
      for (const f of files) {
        if (applied.has(f.version)) continue;
        const t0 = Date.now();
        await client.query("begin");
        try {
          await client.query(f.sql);
          await client.query(
            "insert into schema_migrations(version, name, checksum, duration_ms) values ($1,$2,$3,$4)",
            [f.version, f.name, f.checksum, Date.now() - t0],
          );
          await client.query("commit");
          log(`✔ ${f.name} (${Date.now() - t0} ms)`);
          count++;
        } catch (e) {
          await client.query("rollback");
          throw new Error(`Falló ${f.name}: ${(e as Error).message}`, { cause: e });
        }
      }
      await runPostMigrate(client, log);
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
    return { applied: count, pending: 0 };
  } finally {
    await client.end();
  }
}

/** Endurecimiento post-migración: revoca anon/authenticated/PUBLIC y garantiza pdp_app + RLS. Siempre idempotente. */
async function runPostMigrate(client: pg.Client, log: (m: string) => void) {
  const file = resolve(MIGRATIONS_DIR, "_post_migrate.sql");
  const sqlText = readFileSync(file, "utf8");
  await client.query("begin");
  try {
    await client.query(sqlText);
    await client.query("commit");
    log("✔ post-migración: superficie pública cerrada (anon/authenticated sin acceso)");
  } catch (e) {
    await client.query("rollback");
    throw new Error(`Falló _post_migrate.sql: ${(e as Error).message}`, { cause: e });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf("--url");
  const url =
    urlIdx >= 0 ? args[urlIdx + 1]! : databaseUrl(args.includes("--test") ? "test" : "migrate");
  migrate(url, { statusOnly: args.includes("--status") }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
