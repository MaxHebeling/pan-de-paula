import { describe, expect, it } from "vitest";
import {
  toCents,
  parseAmount,
  formatMXN,
  applyBps,
  splitCents,
  sumCents,
  assertCents,
  roundHalfUp,
} from "../src/money.ts";

describe("money", () => {
  it("convierte a centavos sin errores de punto flotante", () => {
    expect(toCents("45.50")).toBe(4550);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents("1,234.56")).toBe(123456);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(2.675)).toBe(268);
  });
  it("acepta coma decimal (teclados es-MX) y separadores de miles sin multiplicar por 100", () => {
    // Antes: "45,50" → 455000 (el precio se guardaba como $4,550.00)
    expect(toCents("45,50")).toBe(4550);
    expect(toCents("45,5")).toBe(4550);
    expect(toCents("1.234,50")).toBe(123450);
    expect(toCents("1,234")).toBe(123400);
    expect(toCents("1,234,567")).toBe(123456700);
    expect(toCents("1.234.567")).toBe(123456700);
    expect(toCents("$ 45.50 MXN")).toBe(4550);
    expect(toCents(" 45 ")).toBe(4500);
    expect(toCents("0")).toBe(0);
    expect(parseAmount("12,345.6")).toBe(12345.6);
    expect(() => toCents("45.5.5")).toThrow();
    expect(() => toCents("45,5,5")).toThrow();
    expect(() => toCents("abc")).toThrow(); // antes devolvía 0 (precio $0 silencioso)
    expect(() => toCents("")).toThrow();
    expect(() => toCents("$")).toThrow();
  });
  it("formatea MXN", () => {
    expect(formatMXN(4550)).toMatch(/45\.50/);
    expect(formatMXN(4500, { compact: true })).toMatch(/45/);
    expect(formatMXN(4500, { compact: true })).not.toMatch(/\.00/);
  });
  it("aplica porcentajes en bps con redondeo half-up", () => {
    expect(applyBps(8100, 1000)).toBe(810);
    expect(applyBps(4550, 1500)).toBe(683); // 682.5 → 683
    expect(() => applyBps(100, 10001)).toThrow();
    expect(() => applyBps(1.5 as number, 100)).toThrow();
  });
  it("reparte sin perder centavos", () => {
    const parts = splitCents(10000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(sumCents(parts)).toBe(10000);
  });
  it("rechaza no enteros", () => {
    expect(() => assertCents(10.5)).toThrow();
    expect(() => assertCents(NaN)).toThrow();
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });
});
