/**
 * Recrea una base de datos LOCAL desde cero y aplica migraciones.
 * Protecciones: se niega a correr contra hosts que no sean localhost/127.0.0.1 o si APP_ENV=production.
 * Uso: tsx scripts/reset.ts [--test] [--seed]
 */
import pg from "pg";
import { databaseUrl } from "./env.ts";
import { migrate } from "./migrate.ts";

const args = process.argv.slice(2);
const url = databaseUrl(args.includes("--test") ? "test" : "app");
const u = new URL(url);
if (!["localhost", "127.0.0.1"].includes(u.hostname) || process.env.APP_ENV === "production") {
  console.error(
    `Rechazado: reset solo se permite en localhost (host=${u.hostname}, APP_ENV=${process.env.APP_ENV}).`,
  );
  process.exit(2);
}
const dbName = u.pathname.replace(/^\//, "");
const admin = new URL(url);
admin.pathname = "/postgres";

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(
  `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
  [dbName],
);
await client.query(`drop database if exists "${dbName}"`);
await client.query(`create database "${dbName}"`);
await client.end();
console.info(`Base ${dbName} recreada`);
await migrate(url);
if (args.includes("--seed")) {
  process.env.DATABASE_URL = url;
  await import("./seed.ts");
}
