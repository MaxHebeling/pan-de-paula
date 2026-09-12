/**
 * Importador Google Sheets (XLSX/CSV) → El Pan de Paula.
 *
 * Uso:
 *   pnpm --filter @pdp/db run import -- --file <xlsx|csv> --entity <ingredients|products|recipes|customers|orders|prices>
 *        --mapping <mapping.json> [--sheet <nombre>] [--dry-run | --apply] [--strict] [--staff-email <email>] [--report-dir <dir>]
 *
 * Por defecto simula (--dry-run). Nada se escribe en las tablas del negocio hasta pasar --apply.
 * Siempre crea import_batches / import_rows y un reporte en packages/db/import/reports/<batch>.md.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sql } from "kysely";
import { createDb } from "../src/index.ts";
import { databaseUrl } from "./env.ts";
import { runImport } from "./import/run.ts";
import { ENTITIES, ImportError, type Entity } from "./import/types.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MAPPINGS_DIR = resolve(import.meta.dirname, "../import/mappings");

/**
 * `pnpm --filter @pdp/db run import` corre con cwd = packages/db; el usuario suele escribir rutas desde la raíz.
 * Resolvemos contra INIT_CWD (donde se invocó pnpm), luego cwd, luego la raíz del repo.
 */
function resolveInput(p: string, kind: "file" | "mapping" | "dir"): string {
  if (isAbsolute(p)) return p;
  const bases = [process.env.INIT_CWD, process.cwd(), REPO_ROOT].filter((b): b is string => !!b);
  const candidates = bases.map((b) => resolve(b, p));
  if (kind === "mapping" && !p.includes("/") && !p.includes("\\")) {
    candidates.push(resolve(MAPPINGS_DIR, p.endsWith(".json") ? p : `${p}.json`));
  }
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--" || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function usage(msg?: string): never {
  if (msg) console.error(`✗ ${msg}\n`);
  console.error(
    [
      "Uso: pnpm --filter @pdp/db run import -- --file <archivo> --entity <entidad> --mapping <mapping.json> [opciones]",
      "",
      `  --entity      ${ENTITIES.join(" | ")}`,
      "  --mapping     JSON de mapeo; ruta o nombre de plantilla (ingredientes, productos, recetas, precios, clientes, pedidos, pedidos-largo)",
      "  --sheet       nombre de la hoja (XLSX); default: la del mapeo o la primera",
      "  --dry-run     simula (default). --apply escribe en una transacción",
      "  --strict      cualquier fila con error revierte toda la corrida",
      "  --staff-email quién importa (para auditoría)",
      "  --report-dir  carpeta del reporte .md (default packages/db/import/reports)",
      "  --url         DATABASE_URL alterna (default: .env)",
    ].join("\n"),
  );
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
const file =
  typeof args.file === "string" ? resolveInput(args.file, "file") : usage("Falta --file");
if (!existsSync(file)) usage(`No existe el archivo ${file}`);
const entity = typeof args.entity === "string" ? args.entity : usage("Falta --entity");
if (!ENTITIES.includes(entity as Entity)) usage(`Entidad desconocida "${entity}"`);
const mapping =
  typeof args.mapping === "string"
    ? resolveInput(args.mapping, "mapping")
    : usage("Falta --mapping");
if (!existsSync(mapping)) usage(`No existe el mapeo ${mapping}`);
if (args.apply && args["dry-run"]) usage("Elige --dry-run o --apply, no ambos");
const mode = args.apply ? "apply" : "dry-run";
if (mode === "apply" && process.env.APP_ENV === "production" && !args["yes-production"])
  usage("Estás en producción: agrega --yes-production para confirmar que ya revisaste el dry-run");

const url = typeof args.url === "string" ? args.url : databaseUrl("app");
const { db, pool } = createDb({ connectionString: url, max: 4 });
try {
  let staffId: string | null = null;
  if (typeof args["staff-email"] === "string") {
    const r = await sql<{
      id: string;
    }>`select id from staff_users where email = ${args["staff-email"]} and deleted_at is null`.execute(
      db,
    );
    if (!r.rows[0]) usage(`No existe el usuario ${args["staff-email"]}`);
    staffId = r.rows[0].id;
  }
  const res = await runImport({
    db,
    file,
    entity: entity as Entity,
    mapping,
    sheet: typeof args.sheet === "string" ? args.sheet : undefined,
    mode,
    strict: !!args.strict,
    staffId,
    reportDir:
      typeof args["report-dir"] === "string" ? resolveInput(args["report-dir"], "dir") : undefined,
    log: (m) => console.info(`· ${m}`),
  });
  const c = res.counts;
  console.info("");
  console.info(
    `${res.status === "dry_run" ? "SIMULACIÓN" : res.status === "applied" ? "APLICADO" : "FALLÓ"} · ${res.entity} · batch ${res.batchId}`,
  );
  console.info(
    `  se crean: ${c.created} · se actualizan: ${c.updated} · ya existen: ${c.matched} · omitidas: ${c.skipped} · errores: ${c.error}`,
  );
  for (const r of res.rows
    .filter((r) => r.action === "error" || r.action === "skipped")
    .slice(0, 25))
    console.info(`  fila ${r.rowNumber} [${r.action}] ${r.error}`);
  if (c.error + c.skipped > 25) console.info(`  … y ${c.error + c.skipped - 25} más en el reporte`);
  if (res.reportPath) console.info(`  reporte: ${res.reportPath}`);
  if (res.status === "dry_run") console.info("  Para aplicar: repite el comando con --apply");
  process.exitCode = res.status === "failed" ? 1 : 0;
} catch (e) {
  if (e instanceof ImportError) console.error(`✗ ${e.message}`);
  else console.error("✗ Error inesperado:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
  await pool.end().catch(() => {});
}
