import { describe, expect, it } from "vitest";
import {
  canonicalPhone,
  DEFAULT_PHONE_COUNTRY,
  findPhoneCountry,
  parseOptionalPhone,
  parsePhone,
  phoneCountryOrDefault,
  phoneExample,
  phoneMX,
  phoneToE164Digits,
  PHONE_COUNTRIES,
  splitStoredPhone,
} from "../src/index.ts";

/** Un número nacional válido y uno con la longitud equivocada, por país del catálogo. */
const CASES: Record<string, { ok: string; bad: string; stored: string }> = {
  MX: { ok: "664 123 4567", bad: "664 123 456", stored: "6641234567" },
  AR: { ok: "11 2345 6789", bad: "11 2345 678", stored: "+541123456789" },
  CA: { ok: "604 555 0132", bad: "604 555 013", stored: "+16045550132" },
  CL: { ok: "9 6123 4567", bad: "9 6123 456", stored: "+56961234567" },
  CO: { ok: "300 123 4567", bad: "300 123 456", stored: "+573001234567" },
  CR: { ok: "8312 3456", bad: "8312 345", stored: "+50683123456" },
  EC: { ok: "99 123 4567", bad: "99 123 45", stored: "+593991234567" },
  ES: { ok: "612 345 678", bad: "612 345 67", stored: "+34612345678" },
  US: { ok: "619 555 0100", bad: "619 555 010", stored: "+16195550100" },
  GT: { ok: "5123 4567", bad: "5123 456", stored: "+50251234567" },
  PE: { ok: "987 654 321", bad: "987 654 32", stored: "+51987654321" },
  DO: { ok: "809 555 0123", bad: "809 555 012", stored: "+18095550123" },
};

describe("catálogo de países", () => {
  it("México es el primero y el país por defecto", () => {
    expect(PHONE_COUNTRIES[0]!.iso).toBe("MX");
    expect(DEFAULT_PHONE_COUNTRY).toBe("MX");
    expect(phoneCountryOrDefault(null).iso).toBe("MX");
    expect(phoneCountryOrDefault("no-existe").iso).toBe("MX");
    expect(phoneCountryOrDefault("us").iso).toBe("US");
  });

  it("incluye los países pedidos y cada entrada está completa", () => {
    for (const iso of Object.keys(CASES)) expect(findPhoneCountry(iso), iso).not.toBeNull();
    for (const c of PHONE_COUNTRIES) {
      expect(c.iso, c.iso).toMatch(/^[A-Z]{2}$/);
      expect(c.dial, c.iso).toMatch(/^\d{1,3}$/);
      expect(c.flag.length, c.iso).toBeGreaterThan(1);
      expect(c.lengths.length, c.iso).toBeGreaterThan(0);
      // El ejemplo del país debe ser un número que el propio validador acepte.
      const r = parsePhone(c.iso, c.example);
      expect(r.ok, `${c.iso}: ${c.example}`).toBe(true);
    }
  });
});

describe("parsePhone por país", () => {
  for (const [iso, c] of Object.entries(CASES)) {
    it(`${iso}: número válido → canónico, longitud equivocada → error`, () => {
      const good = parsePhone(iso, c.ok);
      expect(good.ok, c.ok).toBe(true);
      if (good.ok) expect(good.value).toBe(c.stored);

      const bad = parsePhone(iso, c.bad);
      expect(bad.ok, c.bad).toBe(false);
      if (!bad.ok) {
        expect(bad.error).toMatch(/dígitos/);
        expect(bad.error).toContain(findPhoneCountry(iso)!.name);
      }
    });

    it(`${iso}: pegado con prefijo, espacios, guiones y paréntesis`, () => {
      const country = findPhoneCountry(iso)!;
      const national = c.ok.replace(/\D/g, "");
      for (const raw of [
        `+${country.dial} ${c.ok}`,
        `+${country.dial}-${national}`,
        `00${country.dial}${national}`,
        `${country.dial} (${national.slice(0, 3)}) ${national.slice(3)}`,
        ` ${c.ok} `,
      ]) {
        const r = parsePhone(iso, raw);
        expect(r.ok, `${iso} · ${raw}`).toBe(true);
        if (r.ok) expect(r.value, `${iso} · ${raw}`).toBe(c.stored);
      }
    });
  }

  it("México sigue guardándose con 10 dígitos pelados", () => {
    for (const raw of [
      "6641234567",
      "664 123 4567",
      "(664) 123-4567",
      "+52 664 123 4567",
      "52 664 123 4567",
      "+52 1 664 123 4567",
      "01 664 123 4567",
      "0052 664 123 4567",
    ]) {
      const r = parsePhone("MX", raw);
      expect(r.ok, raw).toBe(true);
      if (r.ok) expect(r.value, raw).toBe("6641234567");
    }
  });

  it("pegar un internacional de otro país gana sobre el país seleccionado", () => {
    const r = parsePhone("MX", "+1 (619) 555-0100");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe("+16195550100");
      expect(r.country.iso).toBe("US");
    }
    // …y si el país elegido comparte prefijo, se respeta el elegido (mismo valor guardado).
    const rd = parsePhone("DO", "+1 809 555 0123");
    expect(rd.ok).toBe(true);
    if (rd.ok) {
      expect(rd.country.iso).toBe("DO");
      expect(rd.value).toBe("+18095550123");
    }
  });

  it("errores claros en español", () => {
    const vacio = parsePhone("MX", "   ");
    expect(vacio.ok).toBe(false);
    if (!vacio.ok) expect(vacio.error).toBe("Escribe un número de teléfono.");

    const raro = parsePhone("MX", "+99912345678901");
    expect(raro.ok).toBe(false);
    if (!raro.ok) expect(raro.error).toMatch(/internacional/i);

    const corto = parsePhone("ES", "12");
    expect(corto.ok).toBe(false);
    if (!corto.ok) expect(corto.error).toContain("España");
  });

  it("parseOptionalPhone: vacío es null, no error", () => {
    expect(parseOptionalPhone("MX", "")).toEqual({ ok: true, value: null });
    expect(parseOptionalPhone("MX", "   ")).toEqual({ ok: true, value: null });
    expect(parseOptionalPhone(null, undefined)).toEqual({ ok: true, value: null });
    expect(parseOptionalPhone("US", "619 555 0100")).toEqual({ ok: true, value: "+16195550100" });
    expect(parseOptionalPhone("US", "1").ok).toBe(false);
  });

  it("phoneExample se puede leer en el aria-describedby", () => {
    expect(phoneExample(findPhoneCountry("MX")!)).toBe("Ejemplo: 664 123 4567");
  });
});

describe("splitStoredPhone (repoblar el campo al editar)", () => {
  it("devuelve el país y el número nacional de cada forma guardada", () => {
    for (const [iso, c] of Object.entries(CASES)) {
      const s = splitStoredPhone(c.stored);
      const expected = findPhoneCountry(iso)!;
      // "+1" es ambiguo: se muestra Estados Unidos salvo que el número no sea de ese plan.
      if (expected.dial === "1" && iso !== "US") expect(s.country.dial).toBe("1");
      else expect(s.country.iso, iso).toBe(iso);
      expect(s.national, iso).toBe(c.ok.replace(/\D/g, ""));
      // Ida y vuelta: volver a componer da exactamente lo guardado.
      const back = parsePhone(s.country.iso, s.national);
      expect(back.ok, iso).toBe(true);
      if (back.ok) expect(back.value, iso).toBe(c.stored);
    }
  });

  it("vacío y datos históricos raros no revientan", () => {
    expect(splitStoredPhone(null)).toEqual({ country: findPhoneCountry("MX")!, national: "" });
    expect(splitStoredPhone("+999123").country.iso).toBe("MX");
  });
});

describe("retrocompatibilidad: canonicalPhone y phoneMX siguen igual", () => {
  it("formas mexicanas de siempre → 10 dígitos", () => {
    for (const raw of [
      "6641234567",
      "664 123 4567",
      "(664) 123-4567",
      "+52 664 123 4567",
      "52 664 123 4567",
      "+52 1 664 123 4567",
      "01 664 123 4567",
    ]) {
      expect(canonicalPhone(raw), raw).toBe("6641234567");
      const r = phoneMX.safeParse(raw);
      expect(r.success, raw).toBe(true);
      if (r.success) expect(r.data, raw).toBe("6641234567");
    }
  });

  it("acepta los canónicos internacionales que ahora produce el selector", () => {
    for (const c of Object.values(CASES)) {
      expect(canonicalPhone(c.stored), c.stored).toBe(c.stored);
      const r = phoneMX.safeParse(c.stored);
      expect(r.success, c.stored).toBe(true);
      if (r.success) expect(r.data, c.stored).toBe(c.stored);
    }
  });

  it("sigue rechazando basura", () => {
    expect(phoneMX.safeParse("123").success).toBe(false);
    expect(phoneMX.safeParse("66412345678901234").success).toBe(false);
  });
});

describe("phoneToE164Digits (enlaces de WhatsApp)", () => {
  it("México lleva 52 delante; los extranjeros ya traen su prefijo", () => {
    expect(phoneToE164Digits("6641234567")).toBe("526641234567");
    expect(phoneToE164Digits("+16195550100")).toBe("16195550100");
    expect(phoneToE164Digits("+50683123456")).toBe("50683123456");
    expect(phoneToE164Digits("+34612345678")).toBe("34612345678");
    expect(phoneToE164Digits("526641234567")).toBe("526641234567");
    expect(phoneToE164Digits("5216641234567")).toBe("526641234567");
    expect(phoneToE164Digits(null)).toBeNull();
    expect(phoneToE164Digits("123")).toBeNull();
  });
});
