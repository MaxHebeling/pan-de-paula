import { describe, expect, it } from "vitest";
import { unitCost, costRecipe, marginBps, suggestedPrice, priceChangePct } from "../src/costing.ts";
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
