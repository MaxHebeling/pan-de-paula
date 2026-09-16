import { describe, expect, it } from "vitest";
import { birthdayGreetingMessage, birthdayGreetingSubject, firstName } from "../src/greetings.ts";

describe("firstName", () => {
  it("toma la primera palabra y conserva acentos", () => {
    expect(firstName("María José Gómez")).toBe("María");
    expect(firstName("Ángel Núñez")).toBe("Ángel");
  });

  it("normaliza mayúsculas de nombres escritos todo en altas o todo en bajas", () => {
    expect(firstName("ana lópez")).toBe("Ana");
    expect(firstName("MARÍA JOSÉ")).toBe("María");
    expect(firstName("JOSÉ")).toBe("José");
  });

  it("respeta la capitalización interna que escribió el staff", () => {
    expect(firstName("DiCaprio Pérez")).toBe("DiCaprio");
    expect(firstName("McCarthy")).toBe("McCarthy");
  });

  it("funciona con un nombre de una sola palabra y con espacios sobrantes", () => {
    expect(firstName("Paula")).toBe("Paula");
    expect(firstName("   Paula   ")).toBe("Paula");
  });

  it("devuelve cadena vacía si no hay nombre", () => {
    expect(firstName("")).toBe("");
    expect(firstName("   ")).toBe("");
  });
});

describe("birthdayGreetingMessage", () => {
  it("usa el primer nombre, saluda y cierra con el nombre del negocio", () => {
    const m = birthdayGreetingMessage({ fullName: "Ana Lucía Méndez" });
    expect(m).toContain("¡Feliz cumpleaños, Ana! 🎂");
    expect(m).toContain("Gracias por elegirnos");
    expect(m.trim().endsWith("Con cariño, El Pan de Paula")).toBe(true);
    // Nunca se filtra el nombre completo ni datos internos
    expect(m).not.toContain("Méndez");
  });

  it("acepta un nombre de una sola palabra", () => {
    expect(birthdayGreetingMessage({ fullName: "Paula" })).toContain("¡Feliz cumpleaños, Paula!");
  });

  it("cae a un saludo sin nombre si el cliente no tiene nombre utilizable", () => {
    const m = birthdayGreetingMessage({ fullName: "  " });
    expect(m).toContain("¡Feliz cumpleaños! 🎂");
    expect(m).not.toContain("undefined");
  });

  it("no menciona el nivel para Nuevo ni Frecuente", () => {
    for (const tierKey of ["new", "frequent", null, undefined]) {
      const m = birthdayGreetingMessage({ fullName: "Ana López", tierKey });
      expect(m).not.toMatch(/VIP|embajador/i);
    }
  });

  it("agrega un cierre propio para VIP y para Embajador", () => {
    const vip = birthdayGreetingMessage({ fullName: "Ana López", tierKey: "vip" });
    expect(vip).toContain("cliente VIP");
    const amb = birthdayGreetingMessage({ fullName: "Ana López", tierKey: "ambassador" });
    expect(amb).toContain("embajador");
    expect(vip).not.toBe(amb);
  });

  it("menciona el beneficio real de puntos solo si el programa está activo y el multiplicador supera 1", () => {
    const activo = birthdayGreetingMessage({
      fullName: "Ana López",
      loyaltyActive: true,
      birthdayMultiplier: 2,
    });
    expect(activo).toContain("puntos dobles");

    const pausado = birthdayGreetingMessage({
      fullName: "Ana López",
      loyaltyActive: false,
      birthdayMultiplier: 2,
    });
    expect(pausado).not.toMatch(/puntos/i);

    const sinMultiplicador = birthdayGreetingMessage({
      fullName: "Ana López",
      loyaltyActive: true,
      birthdayMultiplier: 1,
    });
    expect(sinMultiplicador).not.toMatch(/puntos/i);

    expect(
      birthdayGreetingMessage({ fullName: "Ana", loyaltyActive: true, birthdayMultiplier: 3 }),
    ).toContain("puntos triples");
    expect(
      birthdayGreetingMessage({ fullName: "Ana", loyaltyActive: true, birthdayMultiplier: 4 }),
    ).toContain("4× los puntos de siempre");
  });

  it("nunca promete descuentos, regalos ni beneficios que el sistema no tiene", () => {
    const m = birthdayGreetingMessage({
      fullName: "Ana López",
      tierKey: "vip",
      loyaltyActive: true,
      birthdayMultiplier: 2,
    });
    expect(m).not.toMatch(/descuento|cupón|gratis|regalo|promoción|% de/i);
  });

  it("no usa modismos regionales", () => {
    const variantes = [
      birthdayGreetingMessage({ fullName: "Ana López" }),
      birthdayGreetingMessage({ fullName: "Ana López", tierKey: "vip" }),
      birthdayGreetingMessage({ fullName: "Ana López", tierKey: "ambassador" }),
      birthdayGreetingMessage({
        fullName: "Ana López",
        tierKey: "vip",
        loyaltyActive: true,
        birthdayMultiplier: 2,
      }),
    ];
    const modismos =
      /\b(chido|padrísimo|padrisimo|órale|orale|güey|wey|chévere|chevere|bacán|bacan|guay|vale|tío|che\b|boludo|plata|pana|parcero|mijo|ándale|andale|qué onda|que onda)\b/i;
    for (const m of variantes) {
      expect(m).not.toMatch(modismos);
      // Tuteo neutro (ni "vosotros" ni "ustedes" dirigido a una sola persona)
      expect(m).not.toMatch(/\b(vosotros|os deseamos|habéis)\b/i);
    }
  });

  it("permite personalizar el nombre del negocio", () => {
    const m = birthdayGreetingMessage({ fullName: "Ana", businessName: "Panadería Paula" });
    expect(m.trim().endsWith("Con cariño, Panadería Paula")).toBe(true);
  });

  it("es determinista: el mismo cliente produce siempre el mismo texto", () => {
    const input = {
      fullName: "Ana López",
      tierKey: "vip",
      loyaltyActive: true,
      birthdayMultiplier: 2,
    };
    expect(birthdayGreetingMessage(input)).toBe(birthdayGreetingMessage(input));
  });
});

describe("birthdayGreetingSubject", () => {
  it("incluye el primer nombre y el negocio", () => {
    expect(birthdayGreetingSubject({ fullName: "ana lópez" })).toBe(
      "¡Feliz cumpleaños, Ana! · El Pan de Paula",
    );
  });

  it("funciona sin nombre", () => {
    expect(birthdayGreetingSubject({ fullName: "" })).toBe("¡Feliz cumpleaños! · El Pan de Paula");
  });
});
