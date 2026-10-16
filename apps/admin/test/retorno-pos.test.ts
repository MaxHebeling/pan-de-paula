/**
 * El destino de retorno (`?next=`) al abrir la caja desde el panel de cobro de un pedido.
 *
 * Por qué existe esta prueba: `rutaPosSegura` decide a dónde redirige nuestro propio dominio con un
 * valor que viene de la URL. Si acepta algo que no es una ruta interna, El Pan de Paula sirve una
 * redirección abierta —un enlace que parece del CRM y aterriza en otro sitio—. Dos consumidores
 * dependen de ella (la acción de apertura y la página de caja), así que un descuido se multiplica.
 *
 * Están escritas como intentos de abuso, no como comprobaciones de que "devuelve la ruta".
 */
import { describe, it, expect } from "vitest";
import { rutaPosSegura } from "../lib/retorno-pos.ts";

describe("rutaPosSegura", () => {
  it("acepta las rutas internas que realmente produce el panel de cobro", () => {
    expect(rutaPosSegura("/pos/cobrar/9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d")).toBe(
      "/pos/cobrar/9f1c2b3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    );
    expect(rutaPosSegura("/pos/pendientes")).toBe("/pos/pendientes");
  });

  it("rechaza lo que no es un destino, sin inventar uno", () => {
    expect(rutaPosSegura(undefined)).toBeNull();
    expect(rutaPosSegura(null)).toBeNull();
    expect(rutaPosSegura("")).toBeNull();
  });

  it("rechaza salir del sitio: es el fallo que convierte el retorno en redirección abierta", () => {
    expect(rutaPosSegura("https://ejemplo.com/")).toBeNull();
    expect(rutaPosSegura("http://ejemplo.com/pos/cobrar/x")).toBeNull();
    // Sin esquema, el navegador lee `//host` como otro sitio: es el caso que más se cuela.
    expect(rutaPosSegura("//ejemplo.com/pos/")).toBeNull();
    expect(rutaPosSegura("/\\ejemplo.com/pos/")).toBeNull();
    expect(rutaPosSegura("javascript:alert(1)")).toBeNull();
  });

  it("rechaza el recorrido de directorios, también disfrazado", () => {
    expect(rutaPosSegura("/pos/../usuarios")).toBeNull();
    // Escapado: si alguien decodificara antes de comparar, esto pasaría. Aquí el punto no existe.
    expect(rutaPosSegura("/pos/%2e%2e/%2e%2e/usuarios")).toBeNull();
    expect(rutaPosSegura("/pos/%2E%2E/usuarios")).toBeNull();
  });

  it("rechaza otras zonas del CRM: el retorno es solo del punto de venta", () => {
    expect(rutaPosSegura("/usuarios")).toBeNull();
    expect(rutaPosSegura("/caja")).toBeNull();
    // `/posible` empieza igual que `/pos` y no es el punto de venta: la barra no es decorativa.
    expect(rutaPosSegura("/posible/fuga")).toBeNull();
  });

  it("rechaza consulta, fragmento y cadenas desmedidas", () => {
    expect(rutaPosSegura("/pos/cobrar/x?next=https://ejemplo.com")).toBeNull();
    expect(rutaPosSegura("/pos/cobrar/x#@ejemplo.com")).toBeNull();
    expect(rutaPosSegura(`/pos/${"a".repeat(300)}`)).toBeNull();
  });
});
