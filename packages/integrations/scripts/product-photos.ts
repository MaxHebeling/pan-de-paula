/**
 * Fotos de producto por lote (misma subida que el admin). Uso:
 *   tsx packages/integrations/scripts/product-photos.ts --dir <carpeta> [--manifest fotos.csv] [--apply] [--yes-production]
 * El manifiesto (CSV con encabezados) necesita las columnas Producto y Archivo; Alt es opcional.
 * Por defecto simula. Productos que ya tienen alguna imagen no se tocan.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDb } from "@pdp/db";
import { databaseUrl } from "../../db/scripts/env.ts";
import { attachProductPhotos, parseManifest } from "../src/productPhotos.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const dir = arg("dir");
if (!dir) {
  console.error("Falta --dir <carpeta con las fotos>");
  process.exit(2);
}
const root = resolve(process.env.INIT_CWD ?? process.cwd(), dir);
const rows = parseManifest(readFileSync(join(root, arg("manifest") ?? "fotos.csv"), "utf8"));
const mode = flag("apply") ? "apply" : "dry-run";
if (mode === "apply" && process.env.APP_ENV === "production" && !flag("yes-production")) {
  console.error(
    "Estás en producción: agrega --yes-production para confirmar que ya revisaste la simulación",
  );
  process.exit(2);
}

const { db, pool } = createDb({ connectionString: databaseUrl("app"), max: 2 });
try {
  const results = await attachProductPhotos({ db, dir: root, rows, mode });
  const counts: Record<string, number> = {};
  for (const r of results) {
    counts[r.action] = (counts[r.action] ?? 0) + 1;
    const extra = r.error ? ` · ${r.error}` : "";
    console.info(`  ${r.action.padEnd(18)} ${r.product}${extra}`);
  }
  console.info(`${mode === "apply" ? "APLICADO" : "SIMULACIÓN"} · ${JSON.stringify(counts)}`);
  process.exitCode = results.some((r) => r.action === "error") ? 1 : 0;
} finally {
  await db.destroy();
  await pool.end().catch(() => {});
}
