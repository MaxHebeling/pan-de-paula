import pg from "pg";
import { migrate } from "./migrate.ts";

/** Recrea una base de datos local desde cero y aplica todas las migraciones (solo para suites de prueba). */
export async function recreateDatabase(url: string): Promise<void> {
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) && !process.env.CI) {
    throw new Error("La base de pruebas debe apuntar a localhost fuera de CI");
  }
  const dbName = u.pathname.replace(/^\//, "");
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [dbName],
    );
    await c.query(`drop database if exists "${dbName}"`);
    await c.query(`create database "${dbName}"`);
  } finally {
    await c.end();
  }
  await migrate(url, { log: () => {} });
}
