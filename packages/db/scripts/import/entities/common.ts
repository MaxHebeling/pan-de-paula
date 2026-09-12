/** Utilidades compartidas por los handlers: cargas de catálogo, resolución exacta/similar, filas decididas. */
import { sql, type Kysely } from "kysely";
import type { DB } from "../../../src/generated/db.ts";
import { findSimilar, normalizeName } from "../normalize.ts";
import type { ImportContext, MappedRow, RowAction, RowResult, WorkUnit } from "../types.ts";

export type IngredientRow = {
  id: string;
  name: string;
  brand: string | null;
  base_unit: "g" | "ml" | "pz";
};
export type ProductRow = {
  id: string;
  name: string;
  slug: string;
  category_id: string | null;
  is_active: boolean;
};
export type CategoryRow = { id: string; name: string; slug: string };
export type CustomerRow = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  public_code: string;
};

export async function loadIngredients(db: Kysely<DB>): Promise<IngredientRow[]> {
  return (
    await sql<IngredientRow>`select id, name, brand, base_unit from ingredients where deleted_at is null`.execute(
      db,
    )
  ).rows;
}
export async function loadProducts(db: Kysely<DB>): Promise<ProductRow[]> {
  return (
    await sql<ProductRow>`select id, name, slug, category_id, is_active from products where deleted_at is null`.execute(
      db,
    )
  ).rows;
}
export async function loadCategories(db: Kysely<DB>): Promise<CategoryRow[]> {
  return (
    await sql<CategoryRow>`select id, name, slug from categories where deleted_at is null`.execute(
      db,
    )
  ).rows;
}
export async function loadCustomers(db: Kysely<DB>): Promise<CustomerRow[]> {
  return (
    await sql<CustomerRow>`select id, full_name, phone::text as phone, email::text as email, public_code from customers where deleted_at is null and merged_into_id is null`.execute(
      db,
    )
  ).rows;
}

export type Resolution<T> =
  { kind: "exact"; item: T } | { kind: "similar"; item: T; score: number } | { kind: "none" };

/** Exacto = mismo nombre normalizado (sin acentos/mayúsculas/espacios). Similar = trigramas ≥ umbral. */
export function resolveByName<T>(
  name: string,
  items: T[],
  getName: (t: T) => string,
  ctx: ImportContext,
  extraExact?: (t: T) => boolean,
): Resolution<T> {
  const n = normalizeName(name);
  const exact = items.find((i) => normalizeName(getName(i)) === n || (extraExact?.(i) ?? false));
  if (exact) return { kind: "exact", item: exact };
  const sim = findSimilar(name, items, getName, ctx.options.similarity_threshold);
  if (sim) return { kind: "similar", item: sim.item, score: sim.score };
  return { kind: "none" };
}

export function similarReason(name: string, other: string, score: number, extra = ""): string {
  return `Posible duplicado: «${name}» se parece a «${other}» (${Math.round(score * 100)}%)${extra}. No se fusiona: revísalo a mano o usa options.similar_policy="create".`;
}

export function rowFrom(
  mr: MappedRow,
  action: RowAction,
  normalized: Record<string, unknown> | null = null,
): RowResult {
  return {
    rowNumber: mr.rowNumber,
    raw: mr.raw,
    normalized,
    action,
    targetId: null,
    error: null,
    warnings: [],
  };
}

export function errorUnit(
  mr: MappedRow,
  message: string,
  normalized: Record<string, unknown> | null = null,
): WorkUnit {
  const row = rowFrom(mr, "error", normalized);
  row.error = message;
  return { key: `row-${mr.rowNumber}`, rows: [row] };
}

export function skippedUnit(
  mr: MappedRow,
  reason: string,
  normalized: Record<string, unknown> | null = null,
): WorkUnit {
  const row = rowFrom(mr, "skipped", normalized);
  row.error = reason;
  return { key: `row-${mr.rowNumber}`, rows: [row] };
}

/** Si la fila trae errores de transformación, la decide como error y devuelve la unidad. */
export function mappedErrors(mr: MappedRow): WorkUnit | null {
  if (mr.errors.length === 0) return null;
  return errorUnit(mr, mr.errors.join(" · "), mr.values);
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** Fecha "YYYY-MM-DD" → expresión SQL timestamptz a la hora dada en la zona del negocio. */
export function localTs(date: string, time = "12:00") {
  return sql`((${date}::date + ${time}::time) at time zone (select timezone from business_settings where id = 1))`;
}
