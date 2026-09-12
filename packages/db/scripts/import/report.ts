/** Reporte Markdown de una corrida (para revisar antes de aplicar y para dejar constancia). */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImportCounts, ImportResult, RowResult } from "./types.ts";

const LABEL: Record<RowResult["action"], string> = {
  created: "Se crea",
  updated: "Se actualiza",
  matched: "Ya existe",
  skipped: "Omitida",
  error: "Error",
};

export function countActions(rows: RowResult[]): ImportCounts {
  const c: ImportCounts = { created: 0, updated: 0, matched: 0, skipped: 0, error: 0 };
  for (const r of rows) c[r.action]++;
  return c;
}

export function renderReport(
  res: ImportResult,
  extra: { warnings?: string[]; mappingPath?: string; strict?: boolean } = {},
): string {
  const lines: string[] = [];
  const mode =
    res.status === "dry_run"
      ? "SIMULACIÓN (dry-run) — nada se escribió en las tablas del negocio"
      : res.status === "applied"
        ? "APLICADO"
        : "FALLÓ (se revirtió todo)";
  lines.push(`# Importación · ${res.entity} · ${mode}`, "");
  lines.push(`- Batch: \`${res.batchId}\``);
  lines.push(
    `- Archivo: \`${res.fileName}\`${res.sheetName ? ` · hoja \`${res.sheetName}\`` : ""}`,
  );
  if (extra.mappingPath) lines.push(`- Mapeo: \`${extra.mappingPath}\``);
  lines.push(`- Clave de archivo (idempotencia): \`${res.importKey}\``);
  lines.push(`- Fecha: ${new Date().toISOString()}${extra.strict ? " · modo estricto" : ""}`, "");
  lines.push("## Resumen", "", "| Acción | Filas |", "| --- | ---: |");
  for (const k of ["created", "updated", "matched", "skipped", "error"] as const)
    lines.push(`| ${LABEL[k]} | ${res.counts[k]} |`);
  lines.push(`| **Total** | **${res.rows.length}** |`, "");
  if (extra.warnings?.length) {
    lines.push("## Avisos del mapeo", "");
    for (const w of extra.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  const problems = res.rows.filter((r) => r.action === "error" || r.action === "skipped");
  if (problems.length) {
    lines.push(
      "## Filas que requieren atención",
      "",
      "| Fila | Acción | Motivo | Datos |",
      "| ---: | --- | --- | --- |",
    );
    for (const r of problems)
      lines.push(
        `| ${r.rowNumber} | ${LABEL[r.action]} | ${esc(r.error ?? "")} | ${esc(summ(r.raw))} |`,
      );
    lines.push("");
  }
  const warned = res.rows.filter(
    (r) => r.warnings.length && r.action !== "error" && r.action !== "skipped",
  );
  if (warned.length) {
    lines.push("## Advertencias", "", "| Fila | Acción | Advertencia |", "| ---: | --- | --- |");
    for (const r of warned)
      lines.push(`| ${r.rowNumber} | ${LABEL[r.action]} | ${esc(r.warnings.join(" · "))} |`);
    lines.push("");
  }
  lines.push(
    "## Detalle por fila",
    "",
    "| Fila | Acción | Destino | Datos |",
    "| ---: | --- | --- | --- |",
  );
  for (const r of res.rows)
    lines.push(
      `| ${r.rowNumber} | ${LABEL[r.action]} | ${r.targetId ?? ""} | ${esc(summ(r.raw))} |`,
    );
  lines.push("");
  if (res.status === "dry_run") {
    lines.push(
      "## Siguiente paso",
      "",
      "Si el resumen es correcto, vuelve a correr el mismo comando con `--apply`. Las filas con error se omiten (o detienen todo con `--strict`).",
      "",
    );
  }
  return lines.join("\n");
}

function summ(raw: Record<string, string>): string {
  return Object.entries(raw)
    .filter(([, v]) => v !== "")
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}
function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export async function writeReport(
  dir: string,
  res: ImportResult,
  extra: Parameters<typeof renderReport>[1] = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${res.batchId}.md`);
  await writeFile(path, renderReport(res, extra), "utf8");
  return path;
}
