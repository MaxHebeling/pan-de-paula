/**
 * Lectura de archivos: XLSX (exceljs) y CSV nativo (`;` o `,`, BOM, comillas RFC 4180, CRLF).
 * Devuelve celdas como texto tal cual (la normalización ocurre en transforms.ts).
 */
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { ImportError, type ParsedTable, type RawRow } from "./types.ts";

export type ParseOptions = { sheet?: string; headerRow?: number };

export async function parseFile(path: string, opts: ParseOptions = {}): Promise<ParsedTable> {
  const ext = extname(path).toLowerCase();
  const buf = await readFile(path);
  if (ext === ".xlsx" || ext === ".xlsm") return parseXlsx(buf, opts);
  if (ext === ".csv" || ext === ".txt" || ext === ".tsv")
    return parseCsv(buf.toString("utf8"), opts);
  throw new ImportError(`Formato no soportado: "${ext}". Usa .xlsx o .csv`);
}

// ── CSV ──────────────────────────────────────────────────────────────────────
export function detectDelimiter(firstLine: string): string {
  const candidates = [";", ",", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = countOutsideQuotes(firstLine, d);
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}

/** Parser RFC 4180: comillas dobles, comillas escapadas "", saltos de línea dentro de comillas. */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLineEnd = src.search(/\r?\n/);
  const d = delimiter ?? detectDelimiter(firstLineEnd === -1 ? src : src.slice(0, firstLineEnd));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function parseCsv(text: string, opts: ParseOptions = {}): ParsedTable {
  const matrix = parseCsvText(text);
  return tableFromMatrix(matrix, opts.headerRow ?? 1, null);
}

// ── XLSX ─────────────────────────────────────────────────────────────────────
export async function parseXlsx(buf: Buffer, opts: ParseOptions = {}): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const names = wb.worksheets.map((w) => w.name);
  if (names.length === 0) throw new ImportError("El archivo XLSX no tiene hojas");
  let ws: ExcelJS.Worksheet | undefined;
  if (opts.sheet) {
    const wanted = opts.sheet.trim().toLowerCase();
    ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === wanted);
    if (!ws)
      throw new ImportError(
        `No existe la hoja "${opts.sheet}". Hojas disponibles: ${names.join(", ")}`,
      );
  } else ws = wb.worksheets[0]!;
  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    const values = row.values as ExcelJS.CellValue[]; // índice 1-based
    for (let c = 1; c < values.length; c++) cells.push(cellToString(values[c]));
    matrix[rowNumber - 1] = cells;
  });
  for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = [];
  return tableFromMatrix(matrix, opts.headerRow ?? 1, ws.name);
}

export function cellToString(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isoDate(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return cellToString(v.result as ExcelJS.CellValue);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("hyperlink" in v) return String((v as { text?: unknown }).text ?? v.hyperlink ?? "");
    if ("error" in v) return "";
  }
  return String(v);
}

function isoDate(d: Date): string {
  // exceljs entrega fechas de celda como Date en UTC; solo nos interesa el día.
  return d.toISOString().slice(0, 10);
}

// ── Común ────────────────────────────────────────────────────────────────────
function tableFromMatrix(
  matrix: string[][],
  headerRow: number,
  sheetName: string | null,
): ParsedTable {
  const headerIdx = Math.max(0, headerRow - 1);
  const headerCells = matrix[headerIdx];
  if (!headerCells || headerCells.every((h) => h.trim() === ""))
    throw new ImportError(`No hay encabezados en la fila ${headerRow}`);
  const headers = headerCells.map((h) => h.trim());
  const seen = new Map<string, number>();
  for (const h of headers) {
    if (!h) continue;
    const k = h.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) throw new ImportError(`Encabezados repetidos: ${dups.join(", ")}`);
  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    if (cells.every((c) => c.trim() === "")) continue;
    const rec: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h) rec[h] = (cells[j] ?? "").trim();
    });
    rows.push({ rowNumber: i + 1, cells: rec });
  }
  return { headers: headers.filter(Boolean), rows, sheetName };
}
