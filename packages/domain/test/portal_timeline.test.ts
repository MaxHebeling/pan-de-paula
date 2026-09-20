/**
 * La línea de tiempo que ve el cliente es una LECTURA de los estados que ya existen, no una segunda
 * lógica: aquí se comprueba que cada estado del pedido cae donde debe, que la hora sale del historial
 * y que un pedido cancelado deja de avanzar en vez de mentir.
 */
import { describe, expect, it } from "vitest";
import { portalTimeline, type OrderStatus } from "../src/orders.ts";

const h = (...pares: Array<[OrderStatus, string]>) =>
  pares.map(([status, iso]) => ({ status, at: new Date(iso) }));

const estados = (status: OrderStatus, tipo = "pickup", hist = h()) =>
  portalTimeline(status, tipo, hist).steps.map((s) => `${s.key}:${s.state}`);

describe("línea de tiempo del pedido en el portal", () => {
  it("un pedido recién entrado está en el primer hito", () => {
    expect(estados("new")).toEqual([
      "received:current",
      "confirmed:pending",
      "preparing:pending",
      "ready:pending",
      "done:pending",
    ]);
  });

  it("el estado contable 'pagado' cuenta como confirmado, no como un paso aparte", () => {
    expect(estados("paid")[1]).toBe("confirmed:current");
    expect(estados("confirmed")[1]).toBe("confirmed:current");
  });

  it("avanza hito a hito y deja atrás lo ya cumplido", () => {
    expect(estados("in_production")).toEqual([
      "received:done",
      "confirmed:done",
      "preparing:current",
      "ready:pending",
      "done:pending",
    ]);
    expect(estados("delivered").every((s) => s.endsWith("done") || s.endsWith("current"))).toBe(
      true,
    );
  });

  it("el último hito se llama distinto según cómo recibe el cliente", () => {
    const retiro = portalTimeline("ready_for_pickup", "pickup", h());
    const entrega = portalTimeline("out_for_delivery", "delivery", h());
    expect(retiro.steps[3]!.label).toBe("Listo para recoger");
    expect(entrega.steps[3]!.label).toBe("En camino");
    expect(entrega.steps[4]!.label).toBe("Entregado");
    // El mismo hito, con el estado que le toca a cada modalidad.
    expect(retiro.steps[3]!.state).toBe("current");
    expect(entrega.steps[3]!.state).toBe("current");
  });

  it("la hora de cada hito sale del historial, y es la PRIMERA vez que pasó por ahí", () => {
    const hist = h(
      ["new", "2026-09-20T12:38:00Z"],
      ["confirmed", "2026-09-20T12:40:00Z"],
      ["in_production", "2026-09-20T12:44:00Z"],
      ["ready", "2026-09-20T13:16:00Z"],
      ["ready_for_pickup", "2026-09-20T13:20:00Z"], // mismo hito: no pisa la hora anterior
    );
    const { steps } = portalTimeline("ready_for_pickup", "pickup", hist);
    expect(steps[0]!.at?.toISOString()).toBe("2026-09-20T12:38:00.000Z");
    expect(steps[2]!.at?.toISOString()).toBe("2026-09-20T12:44:00.000Z");
    expect(steps[3]!.at?.toISOString()).toBe("2026-09-20T13:16:00.000Z");
    expect(steps[4]!.at).toBeNull(); // todavía no lo recoge
  });

  it("un pedido cancelado deja de avanzar y muestra hasta dónde llegó", () => {
    const hist = h(
      ["new", "2026-09-20T12:38:00Z"],
      ["confirmed", "2026-09-20T12:40:00Z"],
      ["cancelled", "2026-09-20T12:50:00Z"],
    );
    const { steps, cancelled } = portalTimeline("cancelled", "pickup", hist);
    expect(cancelled).toBe(true);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "pending", "pending", "pending"]);
    // Nada queda marcado como "ahora": el pedido ya no está en curso.
    expect(steps.some((s) => s.state === "current")).toBe(false);
  });
});
