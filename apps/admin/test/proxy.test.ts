/**
 * El guardia de entrada del CRM (`proxy.ts`): qué pasa sin sesión y qué pasa con una mutación de otro sitio.
 *
 * Por qué existe esta prueba: `proxy.ts` es lo primero que ve cada petición del CRM y no tenía ninguna.
 * Es el único sitio donde vive la comprobación CSRF de TODAS las mutaciones, incluidas las rutas
 * públicas como `/api/auth/logout`, y un cambio descuidado en la lista `PUBLIC_PATHS` abre el panel
 * entero sin que nada se queje.
 *
 * Las pruebas están escritas como intentos de ataque, no como comprobaciones de que "devuelve 200".
 */
import { describe, it, expect } from "vitest";
import { proxy } from "../proxy.ts";
import { NextRequest } from "next/server";

const HOST = "crm.pandepaula.com";

function peticion(
  path: string,
  {
    method = "GET",
    headers = {},
    sesion = false,
  }: {
    method?: string;
    headers?: Record<string, string>;
    sesion?: boolean;
  } = {},
): NextRequest {
  const req = new NextRequest(`https://${HOST}${path}`, {
    method,
    headers: { host: HOST, ...headers },
  });
  if (sesion) req.cookies.set("pdp_session", "token-de-prueba");
  return req;
}

describe("proxy del CRM · sesión", () => {
  it("una página sin cookie de sesión redirige a /login conservando el destino", () => {
    const res = proxy(peticion("/pedidos"));
    expect(res.status).toBe(307);
    const destino = new URL(res.headers.get("location")!);
    expect(destino.pathname).toBe("/login");
    expect(destino.searchParams.get("next")).toBe("/pedidos");
  });

  it("una ruta de API sin sesión responde 401 en JSON, no HTML", async () => {
    const res = proxy(peticion("/api/search"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    // Un redirect aquí hacía que `fetch` recibiera HTML con 200 y el CRM mostrara la pantalla en blanco.
    expect(res.headers.get("location")).toBeNull();
  });

  it("las rutas públicas pasan sin sesión", () => {
    for (const p of [
      "/login",
      "/recuperar",
      "/api/health",
      "/api/ready",
      "/api/cron/stock-alerts",
    ]) {
      expect(proxy(peticion(p)).status, p).toBe(200);
    }
  });

  it("un prefijo parecido no cuela: /loginx exige sesión", () => {
    expect(proxy(peticion("/loginx")).status).toBe(307);
  });

  it("con cookie de sesión se deja pasar (la validación real es server-side)", () => {
    expect(proxy(peticion("/pedidos", { sesion: true })).status).toBe(200);
  });
});

describe("proxy del CRM · CSRF en mutaciones", () => {
  it("rechaza un POST cuyo Origin no es el propio host", () => {
    const res = proxy(
      peticion("/api/pos/checkout", {
        method: "POST",
        headers: { origin: "https://sitio-del-atacante.example" },
        sesion: true,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rechaza un POST marcado por el navegador como cross-site aunque NO traiga Origin", () => {
    // Esta es la que faltaba: sin `Origin`, la comprobación anterior no podía decidir y dejaba pasar.
    // `Sec-Fetch-Site` lo escribe el navegador y el atacante no puede falsearlo.
    const res = proxy(
      peticion("/api/pos/checkout", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
        sesion: true,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("deja pasar el POST del propio sitio", () => {
    const res = proxy(
      peticion("/api/pos/checkout", {
        method: "POST",
        headers: { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" },
        sesion: true,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("deja pasar a un cliente que no es navegador (smoke test, cron): sin Origin ni Sec-Fetch-Site", () => {
    const res = proxy(peticion("/api/cron/stock-alerts", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  it("la comprobación CSRF también cubre las rutas públicas, como cerrar sesión", () => {
    const res = proxy(
      peticion("/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://sitio-del-atacante.example" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("un GET de otro sitio no se bloquea: no muta nada y romperlo rompería los enlaces entrantes", () => {
    const res = proxy(peticion("/login", { headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(200);
  });
});
