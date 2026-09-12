/**
 * Orquestación de una importación: archivo → mapeo → plan → (dry-run | apply) → import_batches/import_rows → reporte.
 * Una corrida = una entidad = una transacción (apply). Cada unidad (fila/receta/pedido) corre en un savepoint:
 * si falla, se revierte solo esa unidad y se continúa (salvo --strict, que revierte todo).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../src/generated/db.ts";
import { HANDLERS } from "./entities/index.ts";
import { checkColumns, loadMapping, mapRows } from "./mapping.ts";
import { parseFile } from "./parse.ts";
import { countActions, writeReport } from "./report.ts";
import {
  ImportError,
  type Entity,
  type ImportContext,
  type ImportResult,
  type Mapping,
  type RowResult,
  type WorkUnit,
} from "./types.ts";

export type RunOptions = {
  db: Kysely<DB>;
  file: string;
  entity: Entity;
  mapping: Mapping | string;
  sheet?: string;
  mode: "dry-run" | "apply";
  strict?: boolean;
  staffId?: string | null;
  /** Directorio de reportes; null = no escribir archivo. */
  reportDir?: string | null;
  log?: (m: string) => void;
};

export const DEFAULT_REPORT_DIR = resolve(import.meta.dirname, "../../import/reports");

export async function runImport(o: RunOptions): Promise<ImportResult> {
  const log = o.log ?? (() => {});
  const handler = HANDLERS[o.entity];
  const mapping = typeof o.mapping === "string" ? await loadMapping(o.mapping) : o.mapping;
  if (mapping.entity !== o.entity)
    throw new ImportError(`El mapeo es para "${mapping.entity}" pero pediste --entity ${o.entity}`);
  const sheet = o.sheet ?? mapping.sheet;
  const table = await parseFile(o.file, { sheet, headerRow: mapping.header_row });
  if (table.rows.length === 0) throw new ImportError("El archivo no tiene filas de datos");
  const warnings = checkColumns(mapping, table, handler);
  const bytes = await readFile(o.file);
  const importKey = createHash("sha256")
    .update(bytes)
    .update(`|${table.sheetName ?? ""}|${o.entity}`)
    .digest("hex")
    .slice(0, 16);
  const ctx: ImportContext = {
    db: o.db,
    mapping,
    options: {
      similarity_threshold: 0.7,
      similar_policy: "skip",
      create_missing_customers: true,
      ...(mapping.options ?? {}),
    },
    importKey,
    staffId: o.staffId ?? null,
    mode: o.mode,
  };
  const mapped = mapRows(mapping, table, handler);
  log(
    `Leídas ${mapped.length} filas de ${basename(o.file)}${table.sheetName ? ` (hoja ${table.sheetName})` : ""}`,
  );
  const units = await handler.plan(mapped, ctx);

  const source = extname(o.file).toLowerCase() === ".csv" ? "csv" : "google_sheets_xlsx";
  const batch = await sql<{
    id: string;
  }>`insert into import_batches(source, file_name, sheet_name, entity, status, total_rows, staff_id, summary)
        values (${source}, ${basename(o.file)}, ${table.sheetName}, ${o.entity}, 'pending', ${mapped.length}, ${ctx.staffId}, ${JSON.stringify({ import_key: importKey, mode: o.mode, strict: !!o.strict })}::jsonb) returning id`.execute(
    o.db,
  );
  const batchId = batch.rows[0]!.id;

  let status: ImportResult["status"] = "dry_run";
  let rows: RowResult[];
  if (o.mode === "dry-run") {
    rows = flatten(units);
  } else {
    try {
      rows = await o.db.transaction().execute(async (trx) => {
        if (ctx.staffId)
          await sql`select set_config('app.staff_id', ${ctx.staffId}, true)`.execute(trx);
        await applyUnits(trx, units, !!o.strict);
        return flatten(units);
      });
      status = "applied";
    } catch (e) {
      if (!(e instanceof StrictAbort)) throw e;
      rows = flatten(units);
      status = "failed";
    }
  }
  rows.sort((a, b) => a.rowNumber - b.rowNumber);
  const counts = countActions(rows);

  // Trazabilidad fila a fila (fuera de la transacción de negocio para que sobreviva a un rollback)
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await sql`insert into import_rows(batch_id, row_number, raw, normalized, target_entity, target_id, action, error)
              select ${batchId}, x.row_number, x.raw, x.normalized, ${o.entity}, x.target_id, x.action, x.error
              from jsonb_to_recordset(${JSON.stringify(
                slice.map((r) => ({
                  row_number: r.rowNumber,
                  raw: r.raw,
                  normalized: r.normalized,
                  target_id: r.targetId,
                  action: r.action,
                  error: r.error ?? (r.warnings.length ? r.warnings.join(" · ") : null),
                })),
              )}::jsonb) as x(row_number int, raw jsonb, normalized jsonb, target_id text, action text, error text)`.execute(
      o.db,
    );
  }
  const result: ImportResult = {
    batchId,
    status,
    entity: o.entity,
    importKey,
    counts,
    rows,
    reportPath: null,
    fileName: basename(o.file),
    sheetName: table.sheetName,
  };
  if (o.reportDir !== null) {
    result.reportPath = await writeReport(o.reportDir ?? DEFAULT_REPORT_DIR, result, {
      warnings,
      mappingPath: typeof o.mapping === "string" ? o.mapping : undefined,
      strict: o.strict,
    });
  }
  await sql`update import_batches set status = ${status}, ok_rows = ${counts.created + counts.updated + counts.matched}, error_rows = ${counts.error},
            applied_at = case when ${status} = 'applied' then now() end,
            summary = summary || ${JSON.stringify({ counts, skipped: counts.skipped, report_path: result.reportPath, warnings })}::jsonb
            where id = ${batchId}`.execute(o.db);
  return result;
}

class StrictAbort extends Error {}

async function applyUnits(trx: Transaction<DB>, units: WorkUnit[], strict: boolean) {
  let i = 0;
  for (const u of units) {
    if (!u.apply) {
      if (strict && u.rows.some((r) => r.action === "error")) throw new StrictAbort();
      continue;
    }
    const sp = sql.raw(`sp_${i++}`);
    await sql`savepoint ${sp}`.execute(trx);
    try {
      const r = await u.apply(trx);
      await sql`release savepoint ${sp}`.execute(trx);
      for (const row of u.rows) {
        row.action = r.action;
        row.targetId = r.targetId;
      }
    } catch (e) {
      await sql`rollback to savepoint ${sp}`.execute(trx);
      const msg = (e as { message?: string }).message ?? String(e);
      for (const row of u.rows) {
        row.action = "error";
        row.targetId = null;
        row.error = msg;
      }
      if (strict) throw new StrictAbort();
    }
  }
}

function flatten(units: WorkUnit[]): RowResult[] {
  return units.flatMap((u) => u.rows);
}
