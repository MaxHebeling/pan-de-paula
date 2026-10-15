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

/** Lo mínimo para decidir si un producto se puede vender sin piezas en existencia. */
export type StockGate = { trackStock: boolean; onHand: number; allowPreorder: boolean };

/** Sin piezas. Solo significa algo si el producto lleva control de stock. */
export function isOutOfStock(p: Pick<StockGate, "trackStock" | "onHand">): boolean {
  return p.trackStock && p.onHand <= 0;
}

/**
 * ¿Hay que impedir la venta por falta de existencias?
 *
 * Esta panadería hornea por encargo: un producto en cero **no** está agotado, está "todavía no
 * horneado". `allowPreorder` es lo único que distingue las dos cosas, y por eso es la única razón
 * por la que un cero puede seguir vendiéndose.
 *
 * Vive en el dominio —y no en cada app— porque el sitio y el POS tienen que decidir con la MISMA
 * regla. Cuando cada uno tenía la suya, el POS marcaba "Agotado" y se negaba a cobrar 17 de los 21
 * productos activos, mientras el sitio los vendía sin problema: todos admiten preventa.
 *
 * No mira el precio a propósito. "Sin precio configurado" es otro motivo para no vender, con su
 * propio mensaje, y cada superficie ya lo comprueba por separado.
 */
export function blockedByStock(p: StockGate): boolean {
  return isOutOfStock(p) && !p.allowPreorder;
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
