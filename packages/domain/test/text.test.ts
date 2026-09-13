import { describe, expect, it } from "vitest";
import { csvCell, escapeLike, containsPattern } from "../src/text.ts";

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
