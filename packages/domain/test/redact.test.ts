import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactQueryString, redactUrl } from "../src/redact.ts";

describe("redacción (regresión auditoría 360°: Sentry enviaba access_token y extra.token)", () => {
  it("redacta parámetros sensibles de URL conservando los demás", () => {
    const u = redactUrl(
      "https://x.mx/api/pos?access_token=APP_USR-123456789012345678901&folio=PDP-2026-000001#top",
    );
    expect(u).not.toContain("APP_USR-1234");
    expect(u).toContain("folio=PDP-2026-000001");
    expect(u).toContain("#top");
    expect(redactUrl("https://x.mx/menu")).toBe("https://x.mx/menu");
  });
  it("redacta query string como texto, pares o registro", () => {
    expect(redactQueryString("token=abc&q=croissant")).toBe(
      `token=${encodeURIComponent(REDACTED)}&q=croissant`,
    );
    expect(
      redactQueryString([
        ["api_key", "x"],
        ["q", "pan"],
      ]),
    ).toEqual([
      ["api_key", REDACTED],
      ["q", "pan"],
    ]);
    expect(redactQueryString({ session: "s", page: "2" })).toEqual({
      session: REDACTED,
      page: "2",
    });
  });
  it("redacta claves anidadas y tokens incrustados en texto", () => {
    const out = redact({
      extra: { token: "t", nested: { password: "p", note: "Bearer abcdefghijklmnop" } },
      ok: 1,
    });
    expect(out).toEqual({
      extra: { token: REDACTED, nested: { password: REDACTED, note: `Bearer ${REDACTED}` } },
      ok: 1,
    });
  });
});
