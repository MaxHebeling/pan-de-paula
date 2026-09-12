import { afterEach, describe, expect, it } from "vitest";
import { _setLogSink, createLogger, redact, REDACTED } from "../src/logger.ts";
import { isCronAuthorized } from "../src/jobs.ts";

describe("logger", () => {
  afterEach(() => {
    _setLogSink(null);
    delete process.env.LOG_LEVEL;
  });

  it("redacta claves sensibles de forma recursiva", () => {
    const out = redact({
      user: "ana",
      password: "secreta",
      nested: { access_token: "abc", Authorization: "Bearer x", card: { number: "4111" }, ok: 1 },
      list: [{ secret: "s" }, "texto"],
      "x-signature": "ts=1,v1=abc",
    });
    expect(out).toEqual({
      user: "ana",
      password: REDACTED,
      nested: { access_token: REDACTED, Authorization: REDACTED, card: REDACTED, ok: 1 },
      list: [{ secret: REDACTED }, "texto"],
      "x-signature": REDACTED,
    });
  });

  it("redacta tokens incrustados en texto y tarjetas con Luhn válido", () => {
    expect(redact("Authorization: Bearer APP_USR-1234567890abcdefghijk")).toContain(
      `Bearer ${REDACTED}`,
    );
    expect(redact("token APP_USR-123456789012345678-090909-abcdef")).toContain(REDACTED);
    expect(redact("tarjeta 4111111111111111 ok")).toBe(`tarjeta ${REDACTED} ok`);
    expect(redact("folio 1234567890123 ok")).toBe("folio 1234567890123 ok"); // Luhn inválido → se conserva
  });

  it("emite JSON por línea con nivel, scope y campos redactados; respeta LOG_LEVEL", () => {
    const lines: Array<{ line: string; level: string }> = [];
    _setLogSink((line, level) => lines.push({ line, level }));
    process.env.LOG_LEVEL = "info";
    const log = createLogger("test").child("sub");
    log.debug("no debería salir");
    log.info("hola", { password: "x", orderId: "o1", err: new Error("boom") });
    log.error("falló", { token: "t" });
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!.line);
    expect(first).toMatchObject({
      level: "info",
      scope: "test.sub",
      msg: "hola",
      orderId: "o1",
      password: REDACTED,
    });
    expect(first.err.message).toBe("boom");
    expect(first.time).toMatch(/^\d{4}-/);
    expect(lines[1]!.level).toBe("error");
    expect(JSON.parse(lines[1]!.line).token).toBe(REDACTED);
  });
});

describe("isCronAuthorized", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  it("acepta Bearer exacto y rechaza todo lo demás", () => {
    expect(isCronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    expect(isCronAuthorized(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isCronAuthorized(`Basic ${secret}`, secret)).toBe(false);
    expect(isCronAuthorized(null, secret)).toBe(false);
    expect(isCronAuthorized(`Bearer ${secret}`, undefined)).toBe(false);
    expect(isCronAuthorized("Bearer corto", "corto")).toBe(false); // secreto débil
  });
});
