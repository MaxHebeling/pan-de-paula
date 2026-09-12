/** Genera tipos Kysely desde la base de datos (fuente de verdad = migraciones SQL). */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { databaseUrl } from "./env.ts";

const out = resolve(import.meta.dirname, "../src/generated/db.ts");
mkdirSync(resolve(import.meta.dirname, "../src/generated"), { recursive: true });
execFileSync(
  "npx",
  [
    "kysely-codegen",
    "--dialect",
    "postgres",
    "--url",
    databaseUrl(),
    "--out-file",
    out,
    "--camel-case=false",
    "--include-pattern",
    "public.*",
    "--exclude-pattern",
    "public.schema_migrations",
    "--runtime-enums=false",
  ],
  { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") },
);
console.info(`Tipos generados en ${out}`);
