import { describe, expect, it } from "vitest";
import { pointsForPurchase, resolveTier, tierProgress, isBirthdayToday } from "../src/loyalty.ts";
import { cartTotals, changeDue, quickTenderOptions } from "../src/cart.ts";
import { canTransition, ORDER_TRANSITIONS, ORDER_STATUSES } from "../src/orders.ts";
import { webCheckoutSchema, customerRegistrationSchema } from "../src/validation.ts";
import { slugify, normalizePhone, isCustomerCode } from "../src/ids.ts";
import { expectedClosing } from "../src/inventory.ts";

const program = {
  isActive: true,
  pointsPerUnit: 1,
  unitCents: 1000,
  minPurchaseCents: 0,
  birthdayMultiplier: 2,
  rounding: "floor" as const,
};

describe("fidelización", () => {
  it("1 punto por cada $10 (floor), doble en cumpleaños, bonos por producto", () => {
    expect(pointsForPurchase(program, 13500)).toBe(13);
    expect(pointsForPurchase(program, 13500, { isBirthday: true })).toBe(26);
    expect(pointsForPurchase(program, 13500, { productBonuses: 5 })).toBe(18);
    expect(pointsForPurchase({ ...program, rounding: "round" }, 13500)).toBe(14);
    expect(pointsForPurchase({ ...program, isActive: false }, 13500)).toBe(0);
    expect(pointsForPurchase(program, 13500, { featureEnabled: false })).toBe(0);
    expect(pointsForPurchase({ ...program, minPurchaseCents: 20000 }, 13500)).toBe(0);
  });
  it("niveles y progreso", () => {
    const tiers = [
      { key: "new", name: "Nuevo", rank: 1, minOrders: 0, minSpentCents: 0, minLifetimePoints: 0 },
      {
        key: "frequent",
        name: "Frecuente",
        rank: 2,
        minOrders: 5,
        minSpentCents: 150000,
        minLifetimePoints: 0,
      },
      {
        key: "vip",
        name: "VIP",
        rank: 3,
        minOrders: 15,
        minSpentCents: 500000,
        minLifetimePoints: 0,
      },
    ];
    expect(
      resolveTier(tiers, { totalOrders: 6, totalSpentCents: 200000, lifetimePoints: 0 })?.key,
    ).toBe("frequent");
    expect(
      resolveTier(tiers, { totalOrders: 6, totalSpentCents: 100000, lifetimePoints: 0 })?.key,
    ).toBe("new");
    const p = tierProgress(tiers, tiers[0]!, {
      totalOrders: 3,
      totalSpentCents: 100000,
      lifetimePoints: 0,
    });
    expect(p).toMatchObject({ ordersLeft: 2, spendLeftCents: 50000 });
    expect(isBirthdayToday("1990-09-12", "2026-09-12")).toBe(true);
    expect(isBirthdayToday("1990-09-13", "2026-09-12")).toBe(false);
  });
});

describe("carrito", () => {
  const lines = [
    { productId: "a", name: "Croissant", qty: 2, unitPriceCents: 4500 },
    { productId: "b", name: "Galleta", qty: 1, unitPriceCents: 2500 },
  ];
  it("totales con cupón porcentual y monto", () => {
    expect(cartTotals(lines).totalCents).toBe(11500);
    expect(cartTotals(lines, { discounts: [{ kind: "pct", valueBps: 1000 }] })).toMatchObject({
      discountCents: 1150,
      totalCents: 10350,
    });
    expect(
      cartTotals(lines, { discounts: [{ kind: "amount", valueCents: 99999 }] }).totalCents,
    ).toBe(0);
    expect(
      cartTotals(lines, { discounts: [{ kind: "free_product", productId: "a" }] }).discountCents,
    ).toBe(4500);
    expect(
      cartTotals(lines, { discounts: [{ kind: "pct", valueBps: 5000, productId: "b" }] })
        .discountCents,
    ).toBe(1250);
  });
  it("impuestos solo si los precios no lo incluyen", () => {
    expect(cartTotals(lines, { taxRateBps: 1600, pricesIncludeTax: true }).taxCents).toBe(0);
    expect(cartTotals(lines, { taxRateBps: 1600, pricesIncludeTax: false }).taxCents).toBe(1840);
  });
  it("cambio y billetes rápidos", () => {
    expect(changeDue(11500, 20000)).toBe(8500);
    expect(() => changeDue(11500, 10000)).toThrow();
    expect(quickTenderOptions(11500)).toEqual([11500, 12000, 15000, 20000]);
  });
});

describe("estados de pedido", () => {
  it("matriz coherente: terminales sin salida, todos los estados definidos", () => {
    for (const s of ORDER_STATUSES) expect(ORDER_TRANSITIONS[s]).toBeDefined();
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
    expect(canTransition("new", "paid")).toBe(true);
    expect(canTransition("new", "delivered")).toBe(false);
    expect(canTransition("completed", "refunded")).toBe(true);
  });
});

describe("validación", () => {
  it("checkout web exige carrito, teléfono válido y método", () => {
    const ok = webCheckoutSchema.safeParse({
      items: [{ product_id: "0b2d3a4e-1111-4222-8333-444455556666", qty: 2 }],
      fulfillment_type: "scheduled_pickup",
      customer_name: "Ana",
      customer_phone: "(664) 123-4567",
      payment_method: "mercadopago",
      idempotency_key: "web-1234567890",
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.customer_phone).toBe("6641234567");
    expect(
      webCheckoutSchema.safeParse({
        items: [],
        fulfillment_type: "pickup",
        customer_name: "A",
        customer_phone: "1",
        payment_method: "cash",
        idempotency_key: "x",
      }).success,
    ).toBe(false);
  });
  it("registro de cliente requiere teléfono o email", () => {
    expect(customerRegistrationSchema.safeParse({ full_name: "Ana López" }).success).toBe(false);
    expect(
      customerRegistrationSchema.safeParse({ full_name: "Ana López", email: "ANA@MAIL.COM" })
        .success,
    ).toBe(true);
  });
});

describe("ids e inventario", () => {
  it("slug, teléfono y código", () => {
    expect(slugify("Croissant de Almendra ¡Nuevo!")).toBe("croissant-de-almendra-nuevo");
    expect(normalizePhone("+52 1 664 123 4567")).toBe("+5216641234567");
    expect(normalizePhone("52 664 123 4567")).toBe("6641234567");
    expect(isCustomerCode("pdp-000143")).toBe(true);
    expect(
      expectedClosing({
        opening: 60,
        production: 20,
        sales: 45,
        waste: 3,
        corrections: -2,
        other: 0,
      }),
    ).toBe(30);
  });
});
