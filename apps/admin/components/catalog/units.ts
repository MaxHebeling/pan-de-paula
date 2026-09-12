import type { BaseUnit } from "@pdp/domain";

/** Unidades de compra compatibles con cada unidad base y formato de costo unitario (compartido servidor/cliente). */
export const PURCHASE_UNITS: Record<BaseUnit, Array<{ value: string; label: string }>> = {
  g: [
    { value: "g", label: "gramos (g)" },
    { value: "kg", label: "kilos (kg)" },
    { value: "lb", label: "libras (lb)" },
    { value: "oz", label: "onzas (oz)" },
  ],
  ml: [
    { value: "ml", label: "mililitros (ml)" },
    { value: "l", label: "litros (L)" },
  ],
  pz: [
    { value: "pz", label: "piezas (pz)" },
    { value: "docena", label: "docenas" },
  ],
};

/** Costo unitario en MXN con decimales suficientes (los costos por gramo son fraccionales). */
export function formatUnitCost(v: number): string {
  const digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return "$" + v.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}
