/**
 * Momento del día y lugar del encabezado del CRM.
 *
 * Son reglas pequeñas pero se ven en cada pantalla: un saludo equivocado a las 7 de la noche, o una
 * ciudad inventada, se nota de inmediato.
 */
import { describe, expect, it } from "vitest";
import {
  franjaDe,
  lugarDeZonaHoraria,
  lugarLegible,
  saludoDe,
  saludoPara,
} from "../src/daytime.ts";

describe("franjas del día", () => {
  it("cada hora cae en su franja, incluidos los bordes", () => {
    const esperado: Array<[number, string]> = [
      [0, "noche"],
      [4, "noche"],
      [5, "manana"], // empieza la mañana
      [11, "manana"],
      [12, "mediodia"], // empieza el mediodía
      [13, "mediodia"],
      [14, "tarde"], // empieza la tarde
      [18, "tarde"],
      [19, "noche"], // empieza la noche
      [23, "noche"],
    ];
    for (const [hora, franja] of esperado) expect(franjaDe(hora), `${hora}h`).toBe(franja);
  });

  it("las 24 horas tienen franja (nunca queda un hueco)", () => {
    for (let h = 0; h < 24; h++) expect(franjaDe(h)).toMatch(/manana|mediodia|tarde|noche/);
  });

  it("el saludo es el que dice la gente: el mediodía saluda 'buenas tardes'", () => {
    expect(saludoDe("manana")).toBe("Buenos días");
    expect(saludoDe("mediodia")).toBe("Buenas tardes");
    expect(saludoDe("tarde")).toBe("Buenas tardes");
    expect(saludoDe("noche")).toBe("Buenas noches");
  });

  it("saluda por el nombre de pila, no con el nombre completo", () => {
    expect(saludoPara("Paulina Gonzalez", 15)).toBe("Buenas tardes, Paulina");
    expect(saludoPara("Karla Santoyo Escarcega", 8)).toBe("Buenos días, Karla");
    expect(saludoPara("  Max  ", 21)).toBe("Buenas noches, Max");
  });
});

describe("lugar a partir de la zona horaria", () => {
  it("las zonas de casa se leen bien, con acentos", () => {
    expect(lugarDeZonaHoraria("America/Tijuana")).toEqual({ ciudad: "Tijuana", pais: "México" });
    expect(lugarDeZonaHoraria("America/Monterrey")).toEqual({ ciudad: "Monterrey", pais: "México" });
    expect(lugarDeZonaHoraria("America/Mexico_City")).toEqual({
      ciudad: "Ciudad de México",
      pais: "México",
    });
    expect(lugarLegible(lugarDeZonaHoraria("America/Los_Angeles"))).toBe(
      "Los Ángeles, Estados Unidos",
    );
  });

  it("una zona no listada usa la ciudad que trae la propia zona, sin inventar el país", () => {
    const lisboa = lugarDeZonaHoraria("Europe/Lisbon");
    expect(lisboa?.ciudad).toBe("Lisbon");
    expect(lisboa?.pais).toBe("Europa");
    // Sin guiones bajos a la vista.
    expect(lugarDeZonaHoraria("Asia/Ho_Chi_Minh")?.ciudad).toBe("Ho Chi Minh");
  });

  it("si no se puede saber, se devuelve null en vez de inventar un lugar", () => {
    for (const z of [null, undefined, "", "UTC", "Local"]) expect(lugarDeZonaHoraria(z)).toBeNull();
    expect(lugarLegible(null)).toBeNull();
  });
});
