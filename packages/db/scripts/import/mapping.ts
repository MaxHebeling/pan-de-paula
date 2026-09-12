/** Carga y validación del mapeo JSON; aplica transformaciones a cada fila del archivo. */
import { readFile } from "node:fs/promises";
import { applyTransform } from "./transforms.ts";
import {
  ENTITIES,
  ImportError,
  TRANSFORMS,
  type ColumnSpec,
  type Entity,
  type EntityHandler,
  type MappedRow,
  type Mapping,
  type ParsedTable,
} from "./types.ts";

export async function loadMapping(path: string): Promise<Mapping> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new ImportError(`No se pudo leer el mapeo ${path}: ${(e as Error).message}`);
  }
  return validateMapping(json);
}

export function validateMapping(json: unknown): Mapping {
  if (!json || typeof json !== "object") throw new ImportError("El mapeo debe ser un objeto JSON");
  const m = json as Record<string, unknown>;
  if (!ENTITIES.includes(m.entity as Entity))
    throw new ImportError(`Mapeo: "entity" debe ser una de ${ENTITIES.join(", ")}`);
  if (!m.columns || typeof m.columns !== "object")
    throw new ImportError('Mapeo: falta "columns" (campo destino → columna del archivo)');
  const columns: Record<string, ColumnSpec> = {};
  for (const [field, spec] of Object.entries(m.columns as Record<string, unknown>)) {
    if (typeof spec === "string") columns[field] = { from: spec };
    else if (spec && typeof spec === "object" && typeof (spec as ColumnSpec).from === "string") {
      const s = spec as ColumnSpec;
      if (s.transform && !TRANSFORMS.includes(s.transform))
        throw new ImportError(
          `Mapeo: transformación desconocida "${s.transform}" en "${field}" (usa ${TRANSFORMS.join(", ")})`,
        );
      columns[field] = {
        from: s.from,
        transform: s.transform,
        required: s.required,
        default: s.default,
      };
    } else
      throw new ImportError(`Mapeo: la columna "${field}" debe ser un texto o {from, transform}`);
  }
  const items = m.items as Mapping["items"];
  if (items) {
    if (items.mode === "wide") {
      if (items.product_columns !== "auto" && !Array.isArray(items.product_columns))
        throw new ImportError(
          'Mapeo: items.product_columns debe ser "auto" o una lista de encabezados',
        );
    } else if (items.mode === "long") {
      if (typeof items.product !== "string" || typeof items.qty !== "string")
        throw new ImportError('Mapeo: items.mode "long" requiere "product" y "qty"');
    } else throw new ImportError('Mapeo: items.mode debe ser "wide" o "long"');
  }
  return {
    entity: m.entity as Entity,
    sheet: typeof m.sheet === "string" ? m.sheet : undefined,
    header_row: typeof m.header_row === "number" ? m.header_row : undefined,
    columns,
    items,
    options: (m.options as Mapping["options"]) ?? {},
  };
}

/** Comprueba que las columnas del mapeo existan en el archivo y que las obligatorias estén presentes. */
export function checkColumns(
  mapping: Mapping,
  table: ParsedTable,
  handler: EntityHandler,
): string[] {
  const warnings: string[] = [];
  const headers = new Map(table.headers.map((h) => [h.toLowerCase(), h]));
  for (const [field, spec] of Object.entries(mapping.columns)) {
    if (!handler.fields[field])
      warnings.push(
        `El campo "${field}" no existe para ${handler.entity}; se ignora. Campos válidos: ${Object.keys(handler.fields).join(", ")}`,
      );
    if (!headers.has(spec.from.toLowerCase()))
      throw new ImportError(
        `La columna "${spec.from}" (campo ${field}) no está en el archivo. Encabezados: ${table.headers.join(" | ")}`,
      );
  }
  for (const [field, meta] of Object.entries(handler.fields)) {
    if (meta.required && !mapping.columns[field])
      throw new ImportError(`Falta mapear el campo obligatorio "${field}" (${meta.help})`);
  }
  if (mapping.items?.mode === "long") {
    for (const h of [
      mapping.items.product,
      mapping.items.qty,
      mapping.items.unit_price,
      mapping.items.unit_cost,
    ]) {
      if (h && !headers.has(h.toLowerCase()))
        throw new ImportError(`La columna de ítems "${h}" no está en el archivo`);
    }
  }
  if (mapping.items?.mode === "wide" && Array.isArray(mapping.items.product_columns)) {
    for (const h of mapping.items.product_columns)
      if (!headers.has(h.toLowerCase()))
        throw new ImportError(`La columna de producto "${h}" no está en el archivo`);
  }
  return warnings;
}

/** Busca el encabezado real ignorando mayúsculas/espacios. */
export function headerKey(table: ParsedTable, name: string): string {
  const h = table.headers.find((x) => x.toLowerCase() === name.trim().toLowerCase());
  return h ?? name;
}

export function mapRows(mapping: Mapping, table: ParsedTable, handler: EntityHandler): MappedRow[] {
  const specs = Object.entries(mapping.columns)
    .filter(([field]) => handler.fields[field])
    .map(([field, spec]) => ({
      field,
      from: headerKey(table, spec.from),
      transform: spec.transform ?? handler.fields[field]!.transform,
      required: spec.required ?? handler.fields[field]!.required ?? false,
      default: spec.default,
    }));
  return table.rows.map((r) => {
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const s of specs) {
      const raw = r.cells[s.from] ?? "";
      try {
        let v = applyTransform(s.transform, raw, mapping.options ?? {});
        if ((v === null || v === undefined) && s.default !== undefined)
          v = applyTransform(s.transform, s.default, mapping.options ?? {});
        if ((v === null || v === undefined) && s.required) errors.push(`Falta "${s.from}"`);
        values[s.field] = v ?? null;
      } catch (e) {
        errors.push(`${s.from}: ${(e as Error).message}`);
      }
    }
    return { rowNumber: r.rowNumber, raw: r.cells, values, errors };
  });
}
