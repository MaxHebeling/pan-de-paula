import { describe, expect, it } from "vitest";
import { canAddItems, canEditItems, ORDER_STATUSES } from "../src/orders.ts";

/**
 * Espejo de la barrera de `edit_order_items` (0085). Si se separa de la base, el administrador ve
 * un editor que falla al guardar.
 */
describe("canEditItems", () => {
  it("la venta viva cierra la puerta, sea cual sea el estado", () => {
    for (const status of ORDER_STATUSES) {
      expect(canEditItems({ status, hasActiveSale: true, hasPaymentInProgress: false })).toBe(
        false,
      );
    }
  });

  it("un pago en proceso cierra la puerta: se calculó sobre el total de antes", () => {
    for (const status of ORDER_STATUSES) {
      expect(canEditItems({ status, hasActiveSale: false, hasPaymentInProgress: true })).toBe(
        false,
      );
    }
  });

  it("sin venta ni pago en proceso, sigue exactamente la regla de agregar", () => {
    for (const status of ORDER_STATUSES) {
      expect(canEditItems({ status, hasActiveSale: false, hasPaymentInProgress: false })).toBe(
        canAddItems({ status, hasActiveSale: false }),
      );
    }
  });
});
