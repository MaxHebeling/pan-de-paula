import { describe, expect, it } from "vitest";
import {
  csvCell,
  escapeLike,
  containsPattern,
  findSimilar,
  normalizeName,
  similarity,
} from "../src/text.ts";

describe("escapeLike", () => {
  it("escapa comodines para buscar literal", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c:\\x")).toBe("c:\\\\x");
    expect(containsPattern("%%")).toBe("%\\%\\%%");
    expect(escapeLike("Croissant")).toBe("Croissant");
  });
});

describe("csvCell (regresión: inyección de fórmulas en exportaciones)", () => {
  it("neutraliza celdas que Excel ejecutaría como fórmula", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-Merma rara")).toBe("'-Merma rara");
  });
  it("no altera números negativos ni texto normal", () => {
    expect(csvCell("-2")).toBe("-2");
    expect(csvCell(-2.5)).toBe("-2.5");
    expect(csvCell("+52")).toBe("+52");
    expect(csvCell("Rol de canela")).toBe("Rol de canela");
    expect(csvCell(null)).toBe("");
  });
  it("entrecomilla separadores y comillas", () => {
    expect(csvCell('Pan "de" casa, grande')).toBe('"Pan ""de"" casa, grande"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
});

describe("normalizeName / similarity (alta de productos especiales e importación)", () => {
  it("el mismo nombre escrito distinto normaliza igual", () => {
    expect(normalizeName("  Rosca de Reyes ")).toBe("rosca de reyes");
    expect(normalizeName("ROSCA DE REYES")).toBe("rosca de reyes");
    expect(normalizeName("Panqué de Piña")).toBe("panque de pina");
    expect(normalizeName("Pan de muerto (chico)")).toBe("pan de muerto chico");
    // La ñ se descompone con el resto de los acentos: basta con que ambos lados normalicen igual.
    expect(normalizeName("Ñoño")).toBe(normalizeName("nono"));
  });
  it("similarity: 1 para equivalentes, alto para variantes de escritura, bajo para distintos", () => {
    expect(similarity("Rosca de Reyes", "rosca de reyes")).toBe(1);
    expect(similarity("Rosca de Reyes", "Rosca de Reyes 2026")).toBeGreaterThan(0.8);
    // Chica y grande SÍ son productos distintos: el umbral del CRM (0.8) no debe confundirlos.
    expect(similarity("Rosca de Reyes chica", "Rosca de Reyes grande")).toBeLessThan(0.8);
    expect(similarity("Rosca de Reyes", "Concha de vainilla")).toBeLessThan(0.3);
  });
  it("findSimilar ignora la coincidencia exacta y devuelve la mejor parecida", () => {
    const items = [
      { id: "a", name: "Rosca de Reyes" },
      { id: "b", name: "Rosca de Reyes grande" },
      { id: "c", name: "Concha de chocolate" },
    ];
    expect(findSimilar("rosca de reyes", items, (i) => i.name, 0.8)?.item.id).toBe("b");
    expect(findSimilar("Baguette", items, (i) => i.name, 0.8)).toBeNull();
  });
});
