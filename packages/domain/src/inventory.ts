/** Conciliación de inventario. */
export type ReconciliationRow = {
  opening: number;
  production: number;
  sales: number;
  waste: number;
  corrections: number;
  other: number;
};

export function expectedClosing(r: ReconciliationRow): number {
  return r.opening + r.production - r.sales - r.waste + r.corrections + r.other;
}

export function stockLevel(onHand: number, threshold: number): "out" | "low" | "ok" {
  if (onHand <= 0) return "out";
  if (onHand <= threshold) return "low";
  return "ok";
}

export const WASTE_REASONS = [
  { key: "burnt", label: "Quemado" },
  { key: "broken", label: "Roto" },
  { key: "expired", label: "Vencido" },
  { key: "tasting", label: "Degustación" },
  { key: "gift", label: "Regalo" },
  { key: "courtesy", label: "Cortesía" },
  { key: "internal_use", label: "Consumo interno" },
  { key: "error", label: "Error" },
  { key: "difference", label: "Diferencia" },
  { key: "other", label: "Otro" },
] as const;
export type WasteReason = (typeof WASTE_REASONS)[number]["key"];
