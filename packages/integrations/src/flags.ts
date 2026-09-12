/** Feature flags en DB (tabla `feature_flags`). Lectura simple, sin caché entre requests (serverless). */
import { sql, type Database, type Transaction, type DB } from "@pdp/db";

export async function isFeatureEnabled(
  db: Database | Transaction<DB>,
  key: string,
): Promise<boolean> {
  const r = await sql<{
    enabled: boolean;
  }>`select enabled from feature_flags where key = ${key}`.execute(db);
  return Boolean(r.rows[0]?.enabled);
}

export async function loadFeatureFlags(
  db: Database | Transaction<DB>,
  keys: string[],
): Promise<Record<string, boolean>> {
  if (!keys.length) return {};
  const r = await sql<{
    key: string;
    enabled: boolean;
  }>`select key, enabled from feature_flags where key = any(${keys}::text[])`.execute(db);
  const out: Record<string, boolean> = Object.fromEntries(keys.map((k) => [k, false]));
  for (const row of r.rows) out[row.key] = row.enabled;
  return out;
}
