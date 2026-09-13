/**
 * Convierte un desglose (Breakdown) en las fórmulas legibles "con los números sustituidos":
 *   Costo por pieza = ($152.70 + $0.00 + $0.00) ÷ 12 × (1 + 0%) = $12.73
 * Puro (sin React): sirve en servidor y cliente.
 */
import { formatQty } from "@pdp/domain";
import type { Breakdown } from "./costing-types";
import { formatUnitCost } from "./units";

export type FormulaTone = "green" | "amber" | "red" | "muted";
export type FormulaLine = {
  key: string;
  label: string;
  expr: string;
  result: string;
  tone?: FormulaTone;
  note?: string;
};

/** Centavos (posiblemente fraccionales) → "$1,234.56". */
export function fmtCents(cents: number | null | undefined, digits = 2): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return (
    "$" +
    (cents / 100).toLocaleString("es-MX", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  );
}
/** MXN decimal → "$1,234.56". */
export function fmtMxn(mxn: number | null | undefined): string {
  if (mxn === null || mxn === undefined || !Number.isFinite(mxn)) return "—";
  return fmtCents(mxn * 100);
}
export function fmtPct(bps: number | null | undefined, digits = 1): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  return (bps / 100).toLocaleString("es-MX", { maximumFractionDigits: digits }) + "%";
}
export function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("es-MX", { maximumFractionDigits: digits });
}

export function marginToneFor(margin: number | null, target: number): FormulaTone {
  if (margin === null) return "muted";
  if (margin < 0) return "red";
  if (margin < target) return "amber";
  return "green";
}

/** Costo unitario de un insumo: precio ÷ contenido. */
export function unitCostFormula(
  priceCents: number,
  packageQty: number,
  baseUnit: string,
  unitCost: number,
): FormulaLine {
  return {
    key: "unit-cost",
    label: "Costo unitario",
    expr: `${fmtCents(priceCents)} ÷ ${formatQty(packageQty, baseUnit as "g" | "ml" | "pz")}`,
    result: `${formatUnitCost(unitCost)}/${baseUnit}`,
  };
}

/** Margen sobre precio de venta. */
export function marginFormula(
  priceCents: number | null,
  costCents: number | null,
  marginBps: number | null,
  target: number,
  label = "Margen",
): FormulaLine {
  if (priceCents === null || costCents === null || marginBps === null)
    return { key: label, label, expr: "sin precio o sin costo", result: "—", tone: "muted" };
  return {
    key: label,
    label,
    expr: `(${fmtCents(priceCents)} − ${fmtCents(costCents)}) ÷ ${fmtCents(priceCents)}`,
    result: fmtPct(marginBps),
    tone: marginToneFor(marginBps, target),
    note:
      marginBps < 0
        ? "se vende por debajo del costo"
        : marginBps < target
          ? `bajo el objetivo de ${fmtPct(target, 0)}`
          : undefined,
  };
}

/** Precio sugerido = costo ÷ (1 − margen objetivo), redondeado hacia arriba. */
export function suggestedFormula(
  costCents: number | null,
  targetBps: number,
  stepCents: number,
  rawCents: number | null,
  suggestedCents: number | null,
): FormulaLine {
  if (costCents === null || rawCents === null || suggestedCents === null)
    return {
      key: "suggested",
      label: "Precio sugerido",
      expr: "sin costo",
      result: "—",
      tone: "muted",
    };
  const rounded = Math.abs(rawCents - suggestedCents) > 0.005;
  return {
    key: "suggested",
    label: "Precio sugerido",
    expr: `${fmtCents(costCents)} ÷ (1 − ${fmtPct(targetBps, 0)})`,
    result: rounded
      ? `${fmtCents(rawCents)} → redondeado a ${fmtCents(suggestedCents)}`
      : fmtCents(suggestedCents),
    note: `múltiplo de ${fmtCents(stepCents, stepCents % 100 === 0 ? 0 : 2)} hacia arriba`,
  };
}

/** Todas las fórmulas de una receta, en orden de lectura. */
export function formulaLines(
  b: Breakdown,
  opts: { includeLines?: boolean; channel?: "pos" | "web" | "both" } = {},
): FormulaLine[] {
  const out: FormulaLine[] = [];
  if (!b.has_recipe) {
    out.push({
      key: "none",
      label: "Costo por pieza",
      expr: "sin receta",
      result: "—",
      tone: "muted",
    });
    return out;
  }
  const s = b.settings;
  const lines = b.lines;
  if (opts.includeLines) {
    for (const l of lines) {
      out.push(
        l.unit_cost === null
          ? {
              key: `line-${l.ingredient_id}`,
              label: l.name,
              expr: `${formatQty(l.qty, l.base_unit)} × sin precio`,
              result: "$0.00",
              tone: "amber",
              note: "no suma al costo",
            }
          : {
              key: `line-${l.ingredient_id}`,
              label: l.name,
              expr: `${formatQty(l.qty, l.base_unit)} × ${formatUnitCost(l.unit_cost)}/${l.base_unit}`,
              result: fmtMxn(l.cost_mxn),
            },
      );
    }
  }
  const costs = lines.filter((l) => l.cost_mxn !== null).map((l) => fmtMxn(l.cost_mxn));
  out.push({
    key: "ingredients",
    label: "Insumos por lote",
    expr:
      costs.length === 0
        ? "sin ingredientes"
        : costs.length <= 6
          ? costs.join(" + ")
          : `Σ de ${costs.length} ingredientes`,
    result: fmtMxn(b.ingredients_mxn),
    tone: b.has_missing_prices ? "amber" : undefined,
    note: b.has_missing_prices ? "hay insumos sin precio: el costo real es mayor" : undefined,
  });
  if (b.labor.mode === "per_hour" && b.labor.minutes !== null) {
    out.push({
      key: "labor",
      label: "Mano de obra",
      expr: `${fmtNum(b.labor.minutes, 2)} min ÷ 60 × ${fmtCents(b.labor.rate_cents_per_hour)}/h`,
      result: fmtCents(b.labor.cents),
    });
  } else {
    out.push({
      key: "labor",
      label: "Mano de obra",
      expr:
        b.labor.mode === "per_hour"
          ? "monto por lote (sin minutos capturados)"
          : "monto fijo por lote",
      result: fmtCents(b.labor.cents ?? b.labor.per_batch_cents ?? 0),
    });
  }
  if (b.overhead.mode === "pct_of_ingredients") {
    out.push({
      key: "overhead",
      label: "Indirectos",
      expr: `${fmtMxn(b.ingredients_mxn)} × ${fmtPct(b.overhead.pct_bps, 2)}`,
      result: fmtCents(b.overhead.cents),
    });
  } else {
    out.push({
      key: "overhead",
      label: "Indirectos",
      expr: "monto fijo por lote",
      result: fmtCents(b.overhead.cents ?? b.overhead.fixed_cents ?? 0),
    });
  }
  const waste = b.waste_bps ?? s.default_waste_bps;
  out.push({
    key: "cost",
    label: "Costo por pieza",
    expr: `(${fmtMxn(b.ingredients_mxn)} + ${fmtCents(b.labor.cents)} + ${fmtCents(b.overhead.cents)}) ÷ ${fmtNum(b.yield_qty)} × (1 + ${fmtPct(waste, 2)})`,
    result: fmtCents(b.cost_per_piece_cents),
    note:
      (waste > 0 ? `merma ${fmtPct(waste, 2)}` : "sin merma") +
      (b.waste_source === "default" ? " (default global)" : " (de la receta)"),
  });
  const channel = opts.channel ?? "pos";
  if (channel === "pos" || channel === "both")
    out.push(
      marginFormula(
        b.pos_price_cents,
        b.cost_per_piece_cents,
        b.pos_margin_bps,
        b.target_margin_bps,
        channel === "both" ? "Margen POS" : "Margen",
      ),
    );
  if (channel === "web" || channel === "both")
    out.push(
      marginFormula(
        b.web_price_cents,
        b.cost_per_piece_cents,
        b.web_margin_bps,
        b.target_margin_bps,
        channel === "both" ? "Margen web" : "Margen",
      ),
    );
  out.push({
    ...suggestedFormula(
      b.cost_per_piece_cents,
      b.target_margin_bps,
      s.price_rounding_cents,
      b.suggested_raw_cents,
      b.suggested_price_cents,
    ),
    note: `objetivo ${fmtPct(b.target_margin_bps, 0)} (${b.target_source === "recipe" ? "de la receta" : "default global"}) · múltiplo de ${fmtCents(s.price_rounding_cents, s.price_rounding_cents % 100 === 0 ? 0 : 2)} hacia arriba`,
  });
  return out;
}

/** Texto plano de las fórmulas (para tooltips / CSV). */
export function formulaText(lines: FormulaLine[]): string {
  return lines.map((l) => `${l.label} = ${l.expr} = ${l.result}`).join("\n");
}
