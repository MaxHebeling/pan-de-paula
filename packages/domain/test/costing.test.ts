import { describe, expect, it } from "vitest";
import {
  unitCost,
  costRecipe,
  marginBps,
  suggestedPrice,
  priceChangePct,
  ceilToStep,
  rawSuggestedPrice,
} from "../src/costing.ts";
import { toBaseQty, normalizeUnit, formatQty } from "../src/units.ts";
import { resolvePrice } from "../src/pricing.ts";

describe("costeo (paridad con SQL product_cost_cents)", () => {
  it("mantequilla $400 / 1808 g → costo por gramo", () => {
    expect(unitCost({ priceCents: 40000, packageQty: 1808 })).toBeCloseTo(400 / 1808, 10);
  });
  it("receta: 500 g mantequilla + 1000 g harina, rinde 10 → 1306 centavos (mismo valor que la prueba SQL)", () => {
    const r = costRecipe({
      yieldQty: 10,
      lines: [
        {
          ingredientId: "mant",
          qty: 500,
          unitCost: unitCost({ priceCents: 40000, packageQty: 1808 }),
        },
        {
          ingredientId: "harina",
          qty: 1000,
          unitCost: unitCost({ priceCents: 2000, packageQty: 1000 }),
        },
      ],
    });
    expect(r.costPerPieceCents).toBe(1306);
    expect(r.hasMissingPrices).toBe(false);
    const r2 = costRecipe({
      yieldQty: 10,
      lines: [
        {
          ingredientId: "mant",
          qty: 500,
          unitCost: unitCost({ priceCents: 45000, packageQty: 1808 }),
        },
        {
          ingredientId: "harina",
          qty: 1000,
          unitCost: unitCost({ priceCents: 2000, packageQty: 1000 }),
        },
      ],
    });
    expect(r2.costPerPieceCents).toBe(1444);
  });
  it("marca precios faltantes y suma mano de obra/indirectos por lote", () => {
    const r = costRecipe({
      yieldQty: 4,
      laborCents: 400,
      overheadCents: 200,
      lines: [{ ingredientId: "x", qty: 10, unitCost: null }],
    });
    expect(r.hasMissingPrices).toBe(true);
    expect(r.costPerPieceCents).toBe(150);
  });
  it("merma: costo por pieza × (1 + merma)", () => {
    const base = {
      yieldQty: 10,
      laborCents: 0,
      lines: [{ ingredientId: "x", qty: 1, unitCost: 10 }],
    };
    expect(costRecipe(base).costPerPieceCents).toBe(100);
    expect(costRecipe({ ...base, wasteBps: 1000 }).costPerPieceCents).toBe(110);
    // default global de merma cuando la receta no tiene override; el override de la receta gana
    expect(costRecipe({ ...base, settings: { defaultWasteBps: 500 } }).costPerPieceCents).toBe(105);
    expect(
      costRecipe({ ...base, wasteBps: 1000, settings: { defaultWasteBps: 500 } }).costPerPieceCents,
    ).toBe(110);
    expect(() => costRecipe({ ...base, wasteBps: 20000 })).toThrow(/merma/);
  });
  it("mano de obra por hora e indirectos como % de insumos", () => {
    // insumos $100 → 10000 c; MO 30 min × $120/h = 6000 c; indirectos 10% de insumos = 1000 c; rinde 10; merma 5%
    const r = costRecipe({
      yieldQty: 10,
      laborCents: 999, // ignorado: hay minutos y el modo es por hora
      overheadCents: 999, // ignorado: modo % de insumos
      laborMinutes: 30,
      wasteBps: 500,
      lines: [{ ingredientId: "x", qty: 100, unitCost: 1 }],
      settings: {
        laborMode: "per_hour",
        laborRateCentsPerHour: 12000,
        overheadMode: "pct_of_ingredients",
        overheadPctBps: 1000,
      },
    });
    expect(r.laborCents).toBe(6000);
    expect(r.overheadCents).toBe(1000);
    expect(r.batchCents).toBe(17000);
    expect(r.costPerPieceCents).toBe(1785); // 17000 / 10 × 1.05
    // sin minutos capturados, el modo por hora cae al monto por lote
    const noMinutes = costRecipe({
      yieldQty: 10,
      laborCents: 1200,
      laborMinutes: null,
      lines: [],
      settings: { laborMode: "per_hour", laborRateCentsPerHour: 12000 },
    });
    expect(noMinutes.laborCents).toBe(1200);
    expect(noMinutes.costPerPieceCents).toBe(120);
    // el margen objetivo resuelto: override > default
    expect(costRecipe({ yieldQty: 1, lines: [] }).targetMarginBps).toBe(6000);
    expect(costRecipe({ yieldQty: 1, lines: [], targetMarginBps: 7000 }).targetMarginBps).toBe(
      7000,
    );
  });
  it("precio sugerido redondea hacia arriba al múltiplo configurado (50, 100, 500, 1000)", () => {
    expect(suggestedPrice(1605, 6000, 100)).toBe(4100); // 4012.5
    expect(suggestedPrice(1605, 6000, 50)).toBe(4050);
    expect(suggestedPrice(1605, 6000, 500)).toBe(4500);
    expect(suggestedPrice(1605, 6000, 1000)).toBe(5000);
    expect(suggestedPrice(2000, 6000, 100)).toBe(5000); // múltiplo exacto: no sube al siguiente
    expect(suggestedPrice(1200, 7000, 100)).toBe(4000); // 1200 / 0.3 = 4000 exacto
    expect(suggestedPrice(1273, 6000, 100)).toBe(3200); // 3182.5
    expect(suggestedPrice(0, 6000, 100)).toBe(0);
    expect(() => suggestedPrice(100, 10000)).toThrow(/100%/);
    expect(ceilToStep(5000.000000000001, 100)).toBe(5000);
    expect(ceilToStep(5001, 100)).toBe(5100);
    expect(rawSuggestedPrice(1273, 6000)).toBeCloseTo(3182.5, 6);
  });
  it("margen y precio sugerido", () => {
    expect(marginBps(4500, 1273)).toBe(7171);
    expect(marginBps(0, 100)).toBeNull();
    expect(suggestedPrice(1273, 7000)).toBe(4300); // 1273/0.3 = 4243 → múltiplo de $1 hacia arriba
    expect(priceChangePct(38000, 45000)).toBeCloseTo(18.42, 1);
  });
});

describe("unidades", () => {
  it("convierte kg/l/docena a base", () => {
    expect(toBaseQty(1.808, "kg")).toEqual({ qty: 1808, base: "g" });
    expect(toBaseQty(2, "L")).toEqual({ qty: 2000, base: "ml" });
    expect(toBaseQty(1, "docena")).toEqual({ qty: 12, base: "pz" });
    expect(() => toBaseQty(1, "kg", "ml")).toThrow(/compatible/);
    expect(() => toBaseQty(1, "furlong")).toThrow(/desconocida/);
    expect(normalizeUnit("Gramos")?.base).toBe("g");
    expect(formatQty(1500, "g")).toMatch(/1.5 kg/);
  });
});

describe("resolución de precio", () => {
  const d = (s: string) => new Date(s);
  it("promo vigente > regular canal > regular all", () => {
    const rows = [
      {
        channel: "all" as const,
        kind: "regular" as const,
        priceCents: 4500,
        validFrom: d("2026-01-01"),
        validTo: null,
      },
      {
        channel: "pos" as const,
        kind: "regular" as const,
        priceCents: 4400,
        validFrom: d("2026-01-01"),
        validTo: null,
      },
      {
        channel: "pos" as const,
        kind: "promo" as const,
        priceCents: 4000,
        validFrom: d("2026-02-01"),
        validTo: d("2026-02-15"),
      },
    ];
    expect(resolvePrice(rows, "pos", d("2026-02-10"))?.priceCents).toBe(4000);
    expect(resolvePrice(rows, "pos", d("2026-03-10"))?.priceCents).toBe(4400);
    expect(resolvePrice(rows, "web", d("2026-02-10"))?.priceCents).toBe(4500);
    expect(resolvePrice([], "web")).toBeNull();
  });
});
