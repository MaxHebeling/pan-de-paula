/** Unidades de insumos. Base: g, ml, pz. Compras pueden venir en kg, l, oz, lb, etc. */
export type BaseUnit = "g" | "ml" | "pz";
export type PurchaseUnit = BaseUnit | "kg" | "l" | "oz" | "lb" | "docena" | "paquete" | "caja";

const FACTORS: Record<string, { base: BaseUnit; factor: number }> = {
  g: { base: "g", factor: 1 },
  gr: { base: "g", factor: 1 },
  gramo: { base: "g", factor: 1 },
  gramos: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  kilo: { base: "g", factor: 1000 },
  kilos: { base: "g", factor: 1000 },
  lb: { base: "g", factor: 453.592 },
  oz: { base: "g", factor: 28.3495 },
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  lt: { base: "ml", factor: 1000 },
  litro: { base: "ml", factor: 1000 },
  litros: { base: "ml", factor: 1000 },
  pz: { base: "pz", factor: 1 },
  pza: { base: "pz", factor: 1 },
  pieza: { base: "pz", factor: 1 },
  piezas: { base: "pz", factor: 1 },
  docena: { base: "pz", factor: 12 },
};

export function normalizeUnit(unit: string): { base: BaseUnit; factor: number } | null {
  const k = unit.trim().toLowerCase().replace(/\.$/, "");
  return FACTORS[k] ?? null;
}

/** Convierte una cantidad en la unidad dada a la unidad base. Lanza si la unidad es desconocida o incompatible. */
export function toBaseQty(
  qty: number,
  unit: string,
  expectedBase?: BaseUnit,
): { qty: number; base: BaseUnit } {
  const u = normalizeUnit(unit);
  if (!u) throw new Error(`Unidad desconocida: "${unit}"`);
  if (expectedBase && u.base !== expectedBase)
    throw new Error(`Unidad "${unit}" no es compatible con ${expectedBase}`);
  if (!Number.isFinite(qty) || qty < 0) throw new Error(`Cantidad inválida: ${qty}`);
  return { qty: qty * u.factor, base: u.base };
}

export function formatQty(qty: number, base: BaseUnit): string {
  if (base === "pz") return `${trimNumber(qty)} pz`;
  if (qty >= 1000) return `${trimNumber(qty / 1000)} ${base === "g" ? "kg" : "L"}`;
  return `${trimNumber(qty)} ${base}`;
}

function trimNumber(n: number): string {
  return Number(n.toFixed(3)).toLocaleString("es-MX", { maximumFractionDigits: 3 });
}
