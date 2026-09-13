/**
 * Costeo de recetas. Reproduce la lógica del Google Sheets:
 *  precio insumo → contenido → costo por unidad base → cantidad en receta → costo ingrediente → costo receta → rendimiento → costo por pieza.
 * Espejo de las funciones SQL ingredient_unit_cost / recipe_cost_terms / product_cost_cents / suggested_price_cents
 * (los tests de paridad verifican que ambos lados den lo mismo). SQL es la verdad; esto solo previsualiza.
 *
 *  MO efectiva         = per_batch → laborCents · per_hour → laborMinutes ÷ 60 × tarifa (sin minutos → laborCents)
 *  Indirectos efectivos = fixed → overheadCents · pct_of_ingredients → insumos × pct
 *  Costo por pieza     = (insumos + MO + indirectos) ÷ rendimiento × (1 + merma)
 *  Precio sugerido     = costo ÷ (1 − margen objetivo), redondeado hacia arriba al múltiplo configurado
 */
import { roundHalfUp, type Cents } from "./money.ts";

export type LaborMode = "per_batch" | "per_hour";
export type OverheadMode = "fixed" | "pct_of_ingredients";

/** Parámetros globales de costeo (espejo de la tabla singleton costing_settings). */
export type CostingSettings = {
  defaultTargetMarginBps: number;
  priceRoundingCents: Cents;
  defaultWasteBps: number;
  laborMode: LaborMode;
  laborRateCentsPerHour: Cents;
  overheadMode: OverheadMode;
  overheadPctBps: number;
};

export const PRICE_ROUNDING_STEPS = [50, 100, 500, 1000] as const;

export const DEFAULT_COSTING_SETTINGS: CostingSettings = {
  defaultTargetMarginBps: 6000,
  priceRoundingCents: 100,
  defaultWasteBps: 0,
  laborMode: "per_batch",
  laborRateCentsPerHour: 0,
  overheadMode: "fixed",
  overheadPctBps: 0,
};

export type IngredientPrice = { priceCents: Cents; packageQty: number };
export type RecipeLine = { ingredientId: string; qty: number; unitCost: number | null };
export type RecipeCosting = {
  ingredientsCost: number; // MXN (decimal exacto en la medida de JS; para reportes)
  lines: Array<{ ingredientId: string; qty: number; unitCost: number | null; cost: number | null }>;
  /** MO efectiva redondeada a centavos (para mostrar). */
  laborCents: Cents;
  /** Indirectos efectivos redondeados a centavos (para mostrar). */
  overheadCents: Cents;
  /** MO e indirectos efectivos sin redondear: son los que entran en la fórmula (igual que SQL). */
  laborExact: number;
  overheadExact: number;
  laborMode: LaborMode;
  overheadMode: OverheadMode;
  yieldQty: number;
  wasteBps: number;
  targetMarginBps: number;
  /** insumos × 100 + MO + indirectos (centavos, sin redondear). */
  batchCents: number;
  costPerPieceCents: Cents;
  hasMissingPrices: boolean;
};

/** MXN por unidad base (no centavos: los costos por gramo son fraccionales). */
export function unitCost({ priceCents, packageQty }: IngredientPrice): number {
  if (packageQty <= 0) throw new RangeError("packageQty debe ser > 0");
  return priceCents / 100 / packageQty;
}

/** Mano de obra efectiva del lote (centavos, sin redondear) según el modo configurado. */
export function effectiveLaborCents(
  input: { laborCents: Cents; laborMinutes: number | null | undefined },
  settings: Pick<CostingSettings, "laborMode" | "laborRateCentsPerHour">,
): number {
  if (
    settings.laborMode === "per_hour" &&
    input.laborMinutes !== null &&
    input.laborMinutes !== undefined
  ) {
    return (input.laborMinutes / 60) * settings.laborRateCentsPerHour;
  }
  return input.laborCents;
}

/** Indirectos efectivos del lote (centavos, sin redondear) según el modo configurado. */
export function effectiveOverheadCents(
  input: { overheadCents: Cents; ingredientsCost: number },
  settings: Pick<CostingSettings, "overheadMode" | "overheadPctBps">,
): number {
  if (settings.overheadMode === "pct_of_ingredients") {
    return (input.ingredientsCost * 100 * settings.overheadPctBps) / 10000;
  }
  return input.overheadCents;
}

export function costRecipe(input: {
  lines: RecipeLine[];
  yieldQty: number;
  laborCents?: Cents;
  overheadCents?: Cents;
  /** Minutos de MO por lote (solo cuenta con laborMode = per_hour). */
  laborMinutes?: number | null;
  /** Merma de la receta en bps; null/undefined → default global. */
  wasteBps?: number | null;
  /** Margen objetivo de la receta en bps; null/undefined → default global. */
  targetMarginBps?: number | null;
  settings?: Partial<CostingSettings>;
}): RecipeCosting {
  if (input.yieldQty <= 0) throw new RangeError("yieldQty debe ser > 0");
  const settings: CostingSettings = { ...DEFAULT_COSTING_SETTINGS, ...(input.settings ?? {}) };
  let ingredientsCost = 0;
  let missing = false;
  const lines = input.lines.map((l) => {
    const cost = l.unitCost === null ? null : l.qty * l.unitCost;
    if (cost === null) missing = true;
    else ingredientsCost += cost;
    return { ...l, cost };
  });
  const laborExact = effectiveLaborCents(
    { laborCents: input.laborCents ?? 0, laborMinutes: input.laborMinutes },
    settings,
  );
  const overheadExact = effectiveOverheadCents(
    { overheadCents: input.overheadCents ?? 0, ingredientsCost },
    settings,
  );
  const wasteBps = input.wasteBps ?? settings.defaultWasteBps;
  if (wasteBps < 0 || wasteBps > 10000) throw new RangeError("merma fuera de rango (0–100%)");
  const targetMarginBps = input.targetMarginBps ?? settings.defaultTargetMarginBps;
  const batchCents = ingredientsCost * 100 + laborExact + overheadExact;
  const costPerPieceCents = roundHalfUp((batchCents / input.yieldQty) * (1 + wasteBps / 10000));
  return {
    ingredientsCost,
    lines,
    laborCents: roundHalfUp(laborExact),
    overheadCents: roundHalfUp(overheadExact),
    laborExact,
    overheadExact,
    laborMode: settings.laborMode,
    overheadMode: settings.overheadMode,
    yieldQty: input.yieldQty,
    wasteBps,
    targetMarginBps,
    batchCents,
    costPerPieceCents,
    hasMissingPrices: missing,
  };
}

/** Margen en basis points sobre precio de venta. null si no hay precio. */
export function marginBps(priceCents: Cents, costCents: Cents): number | null {
  if (priceCents <= 0) return null;
  return roundHalfUp(((priceCents - costCents) / priceCents) * 10000);
}

/**
 * Redondea hacia arriba al múltiplo de `step` centavos. Tolera el ruido de punto flotante:
 * 5000.000000000001 se considera múltiplo exacto de 100 (igual que el cálculo numeric de SQL).
 */
export function ceilToStep(rawCents: number, step: Cents): Cents {
  if (step <= 0) throw new RangeError("step debe ser > 0");
  const q = rawCents / step;
  const nearest = Math.round(q);
  const units = Math.abs(q - nearest) < 1e-9 ? nearest : Math.ceil(q);
  return units * step;
}

/** Precio bruto (sin redondear) para alcanzar un margen objetivo. */
export function rawSuggestedPrice(costCents: Cents, targetMarginBps: number): number {
  if (targetMarginBps >= 10000) throw new RangeError("margen objetivo debe ser < 100%");
  if (targetMarginBps < 0) throw new RangeError("margen objetivo no puede ser negativo");
  return costCents / (1 - targetMarginBps / 10000);
}

/** Precio sugerido para alcanzar un margen objetivo (bps), redondeado HACIA ARRIBA a múltiplos de `step` centavos. */
export function suggestedPrice(
  costCents: Cents,
  targetMarginBps: number,
  step: Cents = 100,
): Cents {
  return ceilToStep(rawSuggestedPrice(costCents, targetMarginBps), step);
}

/** Variación porcentual entre dos precios de insumo (para análisis de inflación). */
export function priceChangePct(fromCents: Cents, toCents: Cents): number | null {
  if (fromCents <= 0) return null;
  return ((toCents - fromCents) / fromCents) * 100;
}
