// secret-scan: fixtures — tokens inventados para probar la redacción.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubEvent, REDACTED, sentryBaseOptions } from "./sentry-options";

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

/*
 * Ambiente y versión del SDK. Importa porque `sentryBaseOptions` lo comparten servidor y NAVEGADOR, y
 * en el navegador solo existen las `NEXT_PUBLIC_*`: los errores de producción llegaban a Sentry
 * etiquetados `development` y sin versión, así que una alerta filtrada por `environment:production`
 * —la que recomienda MONITORING.md— no se disparaba nunca para nada de lo que pasa en el navegador.
 */
describe("sentryBaseOptions · ambiente y versión", () => {
  const CLAVES = [
    "NEXT_PUBLIC_APP_ENV",
    "NEXT_PUBLIC_RELEASE",
    "APP_ENV",
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_SHA",
  ] as const;
  const previo: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of CLAVES) {
      previo[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of CLAVES) {
      if (previo[k] === undefined) delete process.env[k];
      else process.env[k] = previo[k];
    }
  });

  it("en el navegador (solo variables NEXT_PUBLIC_) dice production, no development", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    process.env.NEXT_PUBLIC_RELEASE = "abc1234";
    const o = sentryBaseOptions("web");
    expect(o.environment).toBe("production");
    expect(o.release).toBe("abc1234");
  });

  it("en el servidor sigue valiendo APP_ENV y el sha de Vercel", () => {
    process.env.APP_ENV = "production";
    process.env.VERCEL_GIT_COMMIT_SHA = "def5678";
    const o = sentryBaseOptions("web");
    expect(o.environment).toBe("production");
    expect(o.release).toBe("def5678");
  });

  it("una cadena vacía no es una versión ni un ambiente", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "";
    process.env.NEXT_PUBLIC_RELEASE = "";
    process.env.APP_ENV = "staging";
    const o = sentryBaseOptions("web");
    expect(o.environment).toBe("staging");
    expect(o.release).toBeUndefined();
  });

  it("sin nada configurado cae en development y sin versión", () => {
    const o = sentryBaseOptions("web");
    expect(o.environment).toBe("development");
    expect(o.release).toBeUndefined();
  });

  it("etiqueta la app para poder separar tienda y CRM en Sentry", () => {
    expect(sentryBaseOptions("web").initialScope.tags.app).toBe("web");
  });
});
