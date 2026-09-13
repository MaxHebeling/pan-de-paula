import "server-only";
import type { CostingSettings } from "@pdp/domain";
import { db, sql } from "./db";
import {
  normalizeBreakdown,
  settingsFromRow,
  settingsToBreakdownSettings,
  type Breakdown,
  type BreakdownSettings,
  type CostingSettingsRow,
} from "@/components/catalog/costing-types";

/** Parámetros globales de costeo (tabla singleton) en las tres formas que usa la UI. */
export async function loadCostingSettings(): Promise<{
  row: CostingSettingsRow & { updated_at: Date };
  settings: CostingSettings;
  breakdownSettings: BreakdownSettings;
}> {
  const row = await db()
    .selectFrom("costing_settings")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  const settings = settingsFromRow(row);
  return { row, settings, breakdownSettings: settingsToBreakdownSettings(settings) };
}

/** Desglose completo (SQL, la verdad) de un producto; null si no existe. */
export async function loadBreakdown(productId: string): Promise<Breakdown | null> {
  const r = await sql<{ b: unknown }>`select recipe_formula_breakdown(${productId}) as b`.execute(
    db(),
  );
  const b = r.rows[0]?.b;
  return b ? normalizeBreakdown(b) : null;
}
