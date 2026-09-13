/**
 * Tipos del desglose de fórmula (jsonb de recipe_formula_breakdown) y previsualización en TypeScript.
 * SQL es la verdad: aquí solo se recalcula "en vivo" mientras se edita, con el espejo de @pdp/domain.
 */
import {
  costRecipe,
  marginBps,
  rawSuggestedPrice,
  suggestedPrice,
  type BaseUnit,
  type CostingSettings,
  type LaborMode,
  type OverheadMode,
} from "@pdp/domain";

export type BreakdownSettings = {
  default_target_margin_bps: number;
  price_rounding_cents: number;
  default_waste_bps: number;
  labor_mode: LaborMode;
  labor_rate_cents_per_hour: number;
  overhead_mode: OverheadMode;
  overhead_pct_bps: number;
};

export type BreakdownLine = {
  ingredient_id: string;
  name: string;
  base_unit: BaseUnit;
  qty: number;
  unit_cost: number | null;
  cost_mxn: number | null;
};

export type Breakdown = {
  product_id: string;
  product_name: string;
  has_recipe: boolean;
  recipe_id: string | null;
  version: number | null;
  settings: BreakdownSettings;
  lines: BreakdownLine[];
  has_missing_prices: boolean;
  ingredients_mxn: number;
  labor: {
    mode: LaborMode;
    per_batch_cents: number | null;
    minutes: number | null;
    rate_cents_per_hour: number;
    cents: number | null;
  };
  overhead: {
    mode: OverheadMode;
    fixed_cents: number | null;
    pct_bps: number;
    cents: number | null;
  };
  yield_qty: number | null;
  yield_label: string | null;
  waste_bps: number | null;
  waste_source: "default" | "recipe";
  recipe_waste_bps: number | null;
  batch_cents: number | null;
  cost_per_piece_cents: number | null;
  pos_price_cents: number | null;
  web_price_cents: number | null;
  pos_margin_bps: number | null;
  web_margin_bps: number | null;
  target_margin_bps: number;
  target_source: "default" | "recipe";
  recipe_target_margin_bps: number | null;
  suggested_raw_cents: number | null;
  suggested_price_cents: number | null;
};

/** Fila de la tabla costing_settings (tal como la devuelve Kysely). */
export type CostingSettingsRow = {
  default_target_margin_bps: number;
  price_rounding_cents: number;
  default_waste_bps: number;
  labor_mode: string;
  labor_rate_cents_per_hour: number;
  overhead_mode: string;
  overhead_pct_bps: number;
};

export function settingsFromRow(row: CostingSettingsRow | BreakdownSettings): CostingSettings {
  return {
    defaultTargetMarginBps: row.default_target_margin_bps,
    priceRoundingCents: row.price_rounding_cents,
    defaultWasteBps: row.default_waste_bps,
    laborMode: row.labor_mode === "per_hour" ? "per_hour" : "per_batch",
    laborRateCentsPerHour: row.labor_rate_cents_per_hour,
    overheadMode: row.overhead_mode === "pct_of_ingredients" ? "pct_of_ingredients" : "fixed",
    overheadPctBps: row.overhead_pct_bps,
  };
}

export function settingsToBreakdownSettings(s: CostingSettings): BreakdownSettings {
  return {
    default_target_margin_bps: s.defaultTargetMarginBps,
    price_rounding_cents: s.priceRoundingCents,
    default_waste_bps: s.defaultWasteBps,
    labor_mode: s.laborMode,
    labor_rate_cents_per_hour: s.laborRateCentsPerHour,
    overhead_mode: s.overheadMode,
    overhead_pct_bps: s.overheadPctBps,
  };
}

const n = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** El jsonb llega con numerics; normaliza a number y rellena defaults para una fila sin receta. */
export function normalizeBreakdown(raw: unknown): Breakdown {
  const b = (raw ?? {}) as Record<string, unknown>;
  const settings = (b.settings ?? {}) as Record<string, unknown>;
  const labor = (b.labor ?? {}) as Record<string, unknown>;
  const overhead = (b.overhead ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(b.lines) ? (b.lines as Array<Record<string, unknown>>) : [];
  return {
    product_id: String(b.product_id ?? ""),
    product_name: String(b.product_name ?? ""),
    has_recipe: Boolean(b.has_recipe),
    recipe_id: (b.recipe_id as string | null) ?? null,
    version: n(b.version),
    settings: {
      default_target_margin_bps: n(settings.default_target_margin_bps) ?? 6000,
      price_rounding_cents: n(settings.price_rounding_cents) ?? 100,
      default_waste_bps: n(settings.default_waste_bps) ?? 0,
      labor_mode: settings.labor_mode === "per_hour" ? "per_hour" : "per_batch",
      labor_rate_cents_per_hour: n(settings.labor_rate_cents_per_hour) ?? 0,
      overhead_mode:
        settings.overhead_mode === "pct_of_ingredients" ? "pct_of_ingredients" : "fixed",
      overhead_pct_bps: n(settings.overhead_pct_bps) ?? 0,
    },
    lines: lines.map((l) => ({
      ingredient_id: String(l.ingredient_id),
      name: String(l.name ?? ""),
      base_unit: (l.base_unit as BaseUnit) ?? "g",
      qty: n(l.qty) ?? 0,
      unit_cost: n(l.unit_cost),
      cost_mxn: n(l.cost_mxn),
    })),
    has_missing_prices: Boolean(b.has_missing_prices),
    ingredients_mxn: n(b.ingredients_mxn) ?? 0,
    labor: {
      mode: labor.mode === "per_hour" ? "per_hour" : "per_batch",
      per_batch_cents: n(labor.per_batch_cents),
      minutes: n(labor.minutes),
      rate_cents_per_hour: n(labor.rate_cents_per_hour) ?? 0,
      cents: n(labor.cents),
    },
    overhead: {
      mode: overhead.mode === "pct_of_ingredients" ? "pct_of_ingredients" : "fixed",
      fixed_cents: n(overhead.fixed_cents),
      pct_bps: n(overhead.pct_bps) ?? 0,
      cents: n(overhead.cents),
    },
    yield_qty: n(b.yield_qty),
    yield_label: (b.yield_label as string | null) ?? null,
    waste_bps: n(b.waste_bps),
    waste_source: b.waste_source === "recipe" ? "recipe" : "default",
    recipe_waste_bps: n(b.recipe_waste_bps),
    batch_cents: n(b.batch_cents),
    cost_per_piece_cents: n(b.cost_per_piece_cents),
    pos_price_cents: n(b.pos_price_cents),
    web_price_cents: n(b.web_price_cents),
    pos_margin_bps: n(b.pos_margin_bps),
    web_margin_bps: n(b.web_margin_bps),
    target_margin_bps: n(b.target_margin_bps) ?? n(settings.default_target_margin_bps) ?? 6000,
    target_source: b.target_source === "recipe" ? "recipe" : "default",
    recipe_target_margin_bps: n(b.recipe_target_margin_bps),
    suggested_raw_cents: n(b.suggested_raw_cents),
    suggested_price_cents: n(b.suggested_price_cents),
  };
}

/** Cambios que el usuario está escribiendo (antes de guardar). `null` en un override = volver al default. */
export type BreakdownPatch = {
  yield_qty?: number | null;
  labor_cents?: number | null;
  overhead_cents?: number | null;
  labor_minutes?: number | null;
  waste_bps?: number | null;
  target_margin_bps?: number | null;
  pos_price_cents?: number | null;
  web_price_cents?: number | null;
  lines?: BreakdownLine[];
  settings?: Partial<BreakdownSettings>;
};

/**
 * Recalcula el desglose en el cliente con el espejo de @pdp/domain (misma fórmula que SQL).
 * Los campos ausentes del patch conservan el valor guardado.
 */
export function previewBreakdown(base: Breakdown, patch: BreakdownPatch): Breakdown {
  const settings: BreakdownSettings = { ...base.settings, ...(patch.settings ?? {}) };
  const s = settingsFromRow(settings);
  const lines = patch.lines ?? base.lines;
  const yieldQty = patch.yield_qty ?? base.yield_qty ?? 1;
  const laborCents = patch.labor_cents ?? base.labor.per_batch_cents ?? 0;
  const overheadCents = patch.overhead_cents ?? base.overhead.fixed_cents ?? 0;
  const laborMinutes = "labor_minutes" in patch ? patch.labor_minutes : base.labor.minutes;
  const wasteBps = "waste_bps" in patch ? patch.waste_bps : base.recipe_waste_bps;
  const targetOverride =
    "target_margin_bps" in patch ? patch.target_margin_bps : base.recipe_target_margin_bps;
  const pos = "pos_price_cents" in patch ? (patch.pos_price_cents ?? null) : base.pos_price_cents;
  const web = "web_price_cents" in patch ? (patch.web_price_cents ?? null) : base.web_price_cents;
  if (!base.has_recipe && !yieldQty) return base;
  const c = costRecipe({
    lines: lines.map((l) => ({ ingredientId: l.ingredient_id, qty: l.qty, unitCost: l.unit_cost })),
    yieldQty: yieldQty > 0 ? yieldQty : 1,
    laborCents,
    overheadCents,
    laborMinutes,
    wasteBps,
    targetMarginBps: targetOverride,
    settings: s,
  });
  const cost = c.costPerPieceCents;
  const canSuggest = c.targetMarginBps < 10000;
  return {
    ...base,
    settings,
    has_recipe: true,
    lines: c.lines.map((l, i) => ({
      ...lines[i]!,
      cost_mxn: l.cost,
    })),
    has_missing_prices: c.hasMissingPrices,
    ingredients_mxn: c.ingredientsCost,
    labor: {
      mode: s.laborMode,
      per_batch_cents: laborCents,
      minutes: laborMinutes ?? null,
      rate_cents_per_hour: s.laborRateCentsPerHour,
      cents: c.laborExact,
    },
    overhead: {
      mode: s.overheadMode,
      fixed_cents: overheadCents,
      pct_bps: s.overheadPctBps,
      cents: c.overheadExact,
    },
    yield_qty: yieldQty,
    waste_bps: c.wasteBps,
    waste_source: wasteBps === null || wasteBps === undefined ? "default" : "recipe",
    recipe_waste_bps: wasteBps ?? null,
    batch_cents: c.batchCents,
    cost_per_piece_cents: cost,
    pos_price_cents: pos,
    web_price_cents: web,
    pos_margin_bps: pos !== null && pos > 0 ? marginBps(pos, cost) : null,
    web_margin_bps: web !== null && web > 0 ? marginBps(web, cost) : null,
    target_margin_bps: c.targetMarginBps,
    target_source: targetOverride === null || targetOverride === undefined ? "default" : "recipe",
    recipe_target_margin_bps: targetOverride ?? null,
    suggested_raw_cents: canSuggest ? rawSuggestedPrice(cost, c.targetMarginBps) : null,
    suggested_price_cents: canSuggest
      ? suggestedPrice(cost, c.targetMarginBps, s.priceRoundingCents)
      : null,
  };
}

/** Desglose "vacío" para un producto sin receta (permite previsualizar la primera edición). */
export function emptyBreakdown(
  productId: string,
  productName: string,
  settings: BreakdownSettings,
  prices: { pos: number | null; web: number | null },
): Breakdown {
  return {
    product_id: productId,
    product_name: productName,
    has_recipe: false,
    recipe_id: null,
    version: null,
    settings,
    lines: [],
    has_missing_prices: false,
    ingredients_mxn: 0,
    labor: {
      mode: settings.labor_mode,
      per_batch_cents: null,
      minutes: null,
      rate_cents_per_hour: settings.labor_rate_cents_per_hour,
      cents: null,
    },
    overhead: {
      mode: settings.overhead_mode,
      fixed_cents: null,
      pct_bps: settings.overhead_pct_bps,
      cents: null,
    },
    yield_qty: null,
    yield_label: null,
    waste_bps: settings.default_waste_bps,
    waste_source: "default",
    recipe_waste_bps: null,
    batch_cents: null,
    cost_per_piece_cents: null,
    pos_price_cents: prices.pos,
    web_price_cents: prices.web,
    pos_margin_bps: null,
    web_margin_bps: null,
    target_margin_bps: settings.default_target_margin_bps,
    target_source: "default",
    recipe_target_margin_bps: null,
    suggested_raw_cents: null,
    suggested_price_cents: null,
  };
}

/** Tono del margen respecto al objetivo: rojo negativo, ámbar bajo objetivo, verde en meta. */
export function marginTone(
  margin: number | null,
  target: number,
): "green" | "amber" | "red" | "gray" {
  if (margin === null) return "gray";
  if (margin < 0) return "red";
  if (margin < target) return "amber";
  return "green";
}
