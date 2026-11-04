import { describe, expect, it } from "vitest";
import { canAddItems, ORDER_STATUSES } from "../src/orders.ts";

/**
 * La regla que decide si un pedido admite productos nuevos. Existe por duplicado a propósito: en
 * SQL manda `add_order_items` (0084) y aquí se refleja para que la interfaz no ofrezca un botón
 * que la base va a rechazar. Si las dos se separan, el cajero ve un botón que falla al pulsarlo.
 */
describe("canAddItems", () => {
  it("la venta viva cierra la puerta, sea cual sea el estado", () => {
    // Es la regla que protege el dinero: con venta, el total está congelado y el stock descontado.
    for (const status of ORDER_STATUSES) {
      expect(canAddItems({ status, hasActiveSale: true })).toBe(false);
    }
  });

  it("sin venta, admite los estados en que el pan sigue en el mostrador", () => {
    for (const status of [
      "new",
      "confirmed",
      "payment_pending",
      "paid",
      "in_production",
      "ready",
      "ready_for_pickup",
      "out_for_delivery",
    ] as const) {
      expect(canAddItems({ status, hasActiveSale: false })).toBe(true);
    }
  });

  it("no admite un pedido ya entregado, cancelado o reembolsado", () => {
    for (const status of ["delivered", "completed", "cancelled", "refunded"] as const) {
      expect(canAddItems({ status, hasActiveSale: false })).toBe(false);
    }
  });

  it("cubre TODOS los estados: uno nuevo no se cuela sin decidir", () => {
    // Si mañana se agrega un estado a ORDER_STATUSES, esta prueba obliga a pensar de qué lado cae.
    const decididos = new Set([
      "new",
      "confirmed",
      "payment_pending",
      "paid",
      "in_production",
      "ready",
      "ready_for_pickup",
      "out_for_delivery",
      "delivered",
      "completed",
      "cancelled",
      "refunded",
    ]);
    expect(ORDER_STATUSES.filter((s) => !decididos.has(s))).toEqual([]);
  });
});
