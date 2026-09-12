/** Tipos compartidos del importador Google Sheets → El Pan de Paula. */
import type { Kysely, Transaction } from "kysely";
import type { DB } from "../../src/generated/db.ts";

export const ENTITIES = [
  "ingredients",
  "products",
  "recipes",
  "customers",
  "orders",
  "prices",
] as const;
export type Entity = (typeof ENTITIES)[number];

export const TRANSFORMS = ["text", "money", "qty", "unit", "phone", "date", "bool", "int"] as const;
export type Transform = (typeof TRANSFORMS)[number];

/** Una columna de destino: de qué columna del archivo sale y cómo se transforma. */
export type ColumnSpec = {
  from: string;
  transform?: Transform;
  required?: boolean;
  default?: string;
};

export type ItemsWide = {
  mode: "wide";
  /** Encabezados que son productos. "auto" = todos los que no se usan en `columns` ni están en `exclude`. */
  product_columns: "auto" | string[];
  exclude?: string[];
};
export type ItemsLong = {
  mode: "long";
  product: string;
  qty: string;
  unit_price?: string;
  unit_cost?: string;
  /** Campos de destino (de `columns`) que identifican un mismo pedido. Default: ["customer", "date"]. */
  group_by?: string[];
};

export type MappingOptions = {
  /** Coma como separador decimal ("45,50"). Default: heurística (ver transforms.ts). */
  decimal_comma?: boolean;
  /** Formato de fechas en texto. Default dd/mm/yyyy. */
  date_format?: "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
  /** Umbral de similitud (0–1) para reportar posibles duplicados. Default 0.7. */
  similarity_threshold?: number;
  /** Qué hacer con nombres similares a uno existente: "skip" (default) o "create". */
  similar_policy?: "skip" | "create";
  /** Unidad por defecto cuando la columna de unidad viene vacía (ingredientes/recetas). */
  default_unit?: string;
  /** Pedidos: registrar clientes que no existen (requiere teléfono o email). Default true. */
  create_missing_customers?: boolean;
  /** Pedidos: canal por defecto. Default "admin". */
  default_channel?: "pos" | "web" | "admin" | "instagram" | "whatsapp";
  /** Precios: canal por defecto. Default "all". */
  default_price_channel?: "all" | "web" | "pos";
};

export type Mapping = {
  entity: Entity;
  sheet?: string;
  /** Fila (1-based) donde están los encabezados. Default 1. */
  header_row?: number;
  columns: Record<string, ColumnSpec>;
  items?: ItemsWide | ItemsLong;
  options?: MappingOptions;
};

export type RawRow = { rowNumber: number; cells: Record<string, string> };
export type ParsedTable = { headers: string[]; rows: RawRow[]; sheetName: string | null };

export type MappedRow = {
  rowNumber: number;
  raw: Record<string, string>;
  values: Record<string, unknown>;
  errors: string[];
};

export type RowAction = "created" | "updated" | "skipped" | "error" | "matched";

export type RowResult = {
  rowNumber: number;
  raw: Record<string, string>;
  normalized: Record<string, unknown> | null;
  action: RowAction;
  targetId: string | null;
  error: string | null;
  warnings: string[];
};

/** Unidad de trabajo: una o varias filas que se aplican juntas (una receta, un pedido). */
export type WorkUnit = {
  key: string;
  rows: RowResult[];
  /** Ausente cuando la unidad ya está decidida (skipped/error). */
  apply?: (trx: Transaction<DB>) => Promise<{ targetId: string | null; action: RowAction }>;
};

export type ImportContext = {
  db: Kysely<DB>;
  mapping: Mapping;
  options: Required<
    Pick<MappingOptions, "similarity_threshold" | "similar_policy" | "create_missing_customers">
  > &
    MappingOptions;
  importKey: string;
  staffId: string | null;
  mode: "dry-run" | "apply";
};

export type EntityHandler = {
  entity: Entity;
  /** Campos de destino aceptados: transformación por defecto y obligatoriedad. */
  fields: Record<string, { transform: Transform; required?: boolean; help: string }>;
  plan(rows: MappedRow[], ctx: ImportContext): Promise<WorkUnit[]>;
};

export type ImportCounts = Record<RowAction, number>;

export type ImportResult = {
  batchId: string;
  status: "dry_run" | "applied" | "failed";
  entity: Entity;
  importKey: string;
  counts: ImportCounts;
  rows: RowResult[];
  reportPath: string | null;
  fileName: string;
  sheetName: string | null;
};

export class ImportError extends Error {
  constructor(
    message: string,
    readonly rowNumber?: number,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
