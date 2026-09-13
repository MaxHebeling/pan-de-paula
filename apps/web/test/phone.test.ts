import { describe, expect, it } from "vitest";
import { normalizeMxPhone } from "../lib/phone.ts";

describe("normalizeMxPhone (auditoría web)", () => {
  it("deja 10 dígitos tal cual y limpia separadores", () => {
    expect(normalizeMxPhone("6641234567")).toBe("6641234567");
    expect(normalizeMxPhone("(664) 123-4567")).toBe("6641234567");
    expect(normalizeMxPhone(" 664 123 45 67 ")).toBe("6641234567");
  });
  it("quita la lada de país mexicana (+52, 52, 521)", () => {
    expect(normalizeMxPhone("+52 664 123 4567")).toBe("6641234567");
    expect(normalizeMxPhone("526641234567")).toBe("6641234567");
    expect(normalizeMxPhone("+5216641234567")).toBe("6641234567");
  });
  it("no toca formatos que no son MX de 10 dígitos (los valida el esquema)", () => {
    expect(normalizeMxPhone("664123456")).toBe("664123456"); // 9 dígitos → inválido después
    expect(normalizeMxPhone("66412345678")).toBe("66412345678"); // 11 dígitos sin lada conocida
    expect(normalizeMxPhone("+16641234567")).toBe("+16641234567"); // EE. UU.
    expect(normalizeMxPhone("")).toBe("");
    expect(normalizeMxPhone(null)).toBe("");
  });
});
