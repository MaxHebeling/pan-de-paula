import { describe, expect, it } from "vitest";
import { blockedByStock, expectedClosing, isOutOfStock, stockLevel } from "../src/inventory.ts";

describe("stockLevel", () => {
  it("clasifica por umbral", () => {
    expect(stockLevel(0, 5)).toBe("out");
    expect(stockLevel(-3, 5)).toBe("out");
    expect(stockLevel(5, 5)).toBe("low");
    expect(stockLevel(6, 5)).toBe("ok");
  });
});

describe("expectedClosing", () => {
  it("suma producción y correcciones, resta ventas y merma", () => {
    expect(
      expectedClosing({
        opening: 10,
        production: 40,
        sales: 25,
        waste: 3,
        corrections: 1,
        other: -2,
      }),
    ).toBe(21);
  });
});

describe("isOutOfStock", () => {
  it("solo aplica a productos con control de stock", () => {
    expect(isOutOfStock({ trackStock: true, onHand: 0 })).toBe(true);
    expect(isOutOfStock({ trackStock: true, onHand: -4 })).toBe(true);
    expect(isOutOfStock({ trackStock: true, onHand: 1 })).toBe(false);
    // Sin control de stock el número no significa nada: nunca está "sin piezas".
    expect(isOutOfStock({ trackStock: false, onHand: 0 })).toBe(false);
    expect(isOutOfStock({ trackStock: false, onHand: -99 })).toBe(false);
  });
});

describe("blockedByStock", () => {
  /**
   * El caso que motivó esta función: el 10/10/2026 los 21 productos activos de la panadería
   * admitían preventa y 17 estaban en cero. El POS los marcaba "Agotado" y se negaba a cobrarlos
   * mientras el sitio los vendía sin problema. La preventa es lo único que separa "agotado" de
   * "todavía no horneado".
   */
  it("no bloquea un producto en cero que se hornea por encargo", () => {
    expect(blockedByStock({ trackStock: true, onHand: 0, allowPreorder: true })).toBe(false);
    expect(blockedByStock({ trackStock: true, onHand: -12, allowPreorder: true })).toBe(false);
  });

  it("bloquea un producto en cero que no admite preventa", () => {
    expect(blockedByStock({ trackStock: true, onHand: 0, allowPreorder: false })).toBe(true);
    expect(blockedByStock({ trackStock: true, onHand: -1, allowPreorder: false })).toBe(true);
  });

  it("no bloquea nada que tenga piezas", () => {
    expect(blockedByStock({ trackStock: true, onHand: 1, allowPreorder: false })).toBe(false);
    expect(blockedByStock({ trackStock: true, onHand: 50, allowPreorder: true })).toBe(false);
  });

  it("no bloquea un producto sin control de stock, admita preventa o no", () => {
    expect(blockedByStock({ trackStock: false, onHand: 0, allowPreorder: false })).toBe(false);
    expect(blockedByStock({ trackStock: false, onHand: -5, allowPreorder: false })).toBe(false);
  });

  it("decide igual que la regla del sitio para las cuatro combinaciones", () => {
    // Tabla de verdad explícita: es la regla que antes vivía duplicada en el sitio y en el POS,
    // y la divergencia entre ambas copias fue el defecto. Si alguien la cambia, que rompa aquí.
    const casos: Array<[boolean, number, boolean, boolean]> = [
      // trackStock, onHand, allowPreorder, bloquea
      [true, 0, false, true],
      [true, 0, true, false],
      [true, 5, false, false],
      [true, 5, true, false],
      [false, 0, false, false],
      [false, 0, true, false],
    ];
    for (const [trackStock, onHand, allowPreorder, esperado] of casos) {
      expect(blockedByStock({ trackStock, onHand, allowPreorder })).toBe(esperado);
    }
  });
});
