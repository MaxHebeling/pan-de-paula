import pg from "pg";
import { databaseUrl } from "../scripts/env.ts";
import { migrate } from "../scripts/migrate.ts";

/** Recrea la base de pruebas (localhost) y aplica migraciones antes de la suite. */
export default async function setup() {
  const url = databaseUrl("test");
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) && !process.env.CI) {
    throw new Error("DATABASE_URL_TEST debe apuntar a localhost fuera de CI");
  }
  const dbName = u.pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
    [dbName],
  );
  await c.query(`drop database if exists "${dbName}"`);
  await c.query(`create database "${dbName}"`);
  await c.end();
  await migrate(url, { log: () => {} });
  process.env.DATABASE_URL = url;
}
