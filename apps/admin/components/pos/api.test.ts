import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";

const fakeResponse = (init: {
  ok: boolean;
  status: number;
  url: string;
  redirected: boolean;
  contentType: string;
  body: string;
}) =>
  ({
    ok: init.ok,
    status: init.status,
    url: init.url,
    redirected: init.redirected,
    headers: new Headers({ "content-type": init.contentType }),
    text: async () => init.body,
  }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("una redirección a /login (sesión expirada) NO es éxito", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          url: "http://localhost/login?next=%2Fapi%2Fpos%2Fcheckout",
          redirected: true,
          contentType: "text/html; charset=utf-8",
          body: "<html>login</html>",
        }),
      ),
    );
    const r = await apiFetch("/api/pos/checkout", { method: "POST" });
    expect(r).toMatchObject({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  });

  it("un 200 que no es JSON se trata como error del servidor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          url: "http://localhost/api/pos/checkout",
          redirected: false,
          contentType: "text/html",
          body: "<html></html>",
        }),
      ),
    );
    const r = await apiFetch("/api/pos/checkout");
    expect(r).toMatchObject({ ok: false, status: 502 });
  });

  it("JSON válido sigue funcionando", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 201,
          url: "http://localhost/api/pos/checkout",
          redirected: false,
          contentType: "application/json",
          body: '{"folio":"PDP-2026-000001"}',
        }),
      ),
    );
    const r = await apiFetch<{ folio: string }>("/api/pos/checkout");
    expect(r).toEqual({ ok: true, status: 201, data: { folio: "PDP-2026-000001" } });
  });
});
