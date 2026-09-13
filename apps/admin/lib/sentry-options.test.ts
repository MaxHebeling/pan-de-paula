// secret-scan: fixtures — tokens inventados para probar la redacción.
import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubEvent, REDACTED } from "./sentry-options";

describe("scrubEvent (regresión auditoría 360°)", () => {
  it("no deja salir tokens en URL, query string, extra, contexts, breadcrumbs ni cabeceras", () => {
    const ev = {
      type: undefined,
      message: "fallo con Bearer abcdefghijklmnopqrstuv",
      request: {
        url: "https://pan.mx/api/x?access_token=secreto123456789&folio=PDP-1",
        query_string: "access_token=secreto123456789&folio=PDP-1",
        headers: { cookie: "pdp_session=zzz", authorization: "Bearer x", "user-agent": "UA" },
        cookies: { pdp_session: "zzz" },
        data: { password: "p", nombre: "Ana" },
      },
      extra: { token: "t", mercadopago: { access_token: "APP_USR-123456789012345678901" } },
      contexts: { webhook: { signature: "sha256=abc" } },
      breadcrumbs: [
        {
          category: "fetch",
          data: { url: "https://api.mercadopago.com/v1/payments/1?access_token=zzz" },
        },
      ],
      exception: {
        values: [{ type: "Error", value: "token APP_USR-123456789012345678901 inválido" }],
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
    } as unknown as ErrorEvent;
    const out = scrubEvent(ev, {})!;
    const json = JSON.stringify(out);
    expect(json).not.toMatch(
      /secreto123456789|APP_USR-1234|pdp_session=zzz|sha256=abc|access_token=zzz|a@b\.c|1\.2\.3\.4/,
    );
    expect(json).toContain("folio=PDP-1");
    expect(out.request?.headers?.["user-agent"]).toBe("UA");
    expect((out.extra as Record<string, unknown>).token).toBe(REDACTED);
    expect(out.user?.id).toBe("u1");
  });
});
