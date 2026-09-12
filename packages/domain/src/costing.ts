/**
 * Costeo de recetas. Reproduce la lógica del Google Sheets:
 *  precio insumo → contenido → costo por unidad base → cantidad en receta → costo ingrediente → costo receta → rendimiento → costo por pieza.
 * Espejo de las funciones SQL ingredient_unit_cost / product_cost_cents (los tests verifican paridad).
 */
import { roundHalfUp, type Cents } from "./money.ts";

export type IngredientPrice = { priceCents: Cents; packageQty: number };
export type RecipeLine = { ingredientId: string; qty: number; unitCost: number | null };
export type RecipeCosting = {
  ingredientsCost: number; // MXN (decimal exacto en la medida de JS; para reportes)
  lines: Array<{ ingredientId: string; qty: number; unitCost: number | null; cost: number | null }>;
  laborCents: Cents;
  overheadCents: Cents;
  yieldQty: number;
  costPerPieceCents: Cents;
  hasMissingPrices: boolean;
};

/** MXN por unidad base (no centavos: los costos por gramo son fraccionales). */
export function unitCost({ priceCents, packageQty }: IngredientPrice): number {
  if (packageQty <= 0) throw new RangeError("packageQty debe ser > 0");
  return priceCents / 100 / packageQty;
}

export function costRecipe(input: {
  lines: RecipeLine[];
  yieldQty: number;
  laborCents?: Cents;
  overheadCents?: Cents;
}): RecipeCosting {
  if (input.yieldQty <= 0) throw new RangeError("yieldQty debe ser > 0");
  let ingredientsCost = 0;
  let missing = false;
  const lines = input.lines.map((l) => {
    const cost = l.unitCost === null ? null : l.qty * l.unitCost;
    if (cost === null) missing = true;
    else ingredientsCost += cost;
    return { ...l, cost };
  });
  const labor = input.laborCents ?? 0;
  const overhead = input.overheadCents ?? 0;
  const costPerPieceCents = roundHalfUp(
    (ingredientsCost * 100 + labor + overhead) / input.yieldQty,
  );
  return {
    ingredientsCost,
    lines,
    laborCents: labor,
    overheadCents: overhead,
    yieldQty: input.yieldQty,
    costPerPieceCents,
    hasMissingPrices: missing,
  };
}

/** Margen en basis points sobre precio de venta. null si no hay precio. */
export function marginBps(priceCents: Cents, costCents: Cents): number | null {
  if (priceCents <= 0) return null;
  return roundHalfUp(((priceCents - costCents) / priceCents) * 10000);
}

/** Precio sugerido para alcanzar un margen objetivo (bps), redondeado a múltiplos de `step` centavos. */
export function suggestedPrice(
  costCents: Cents,
  targetMarginBps: number,
  step: Cents = 100,
): Cents {
  if (targetMarginBps >= 10000) throw new RangeError("margen objetivo debe ser < 100%");
  const raw = costCents / (1 - targetMarginBps / 10000);
  return Math.ceil(raw / step) * step;
}

/** Variación porcentual entre dos precios de insumo (para análisis de inflación). */
export function priceChangePct(fromCents: Cents, toCents: Cents): number | null {
  if (fromCents <= 0) return null;
  return ((toCents - fromCents) / fromCents) * 100;
}
