/**
 * Carrito en localStorage: versión del esquema, cantidades inválidas (0, negativas, decimales, 999) y
 * datos corruptos. Se simula `window.localStorage` porque el módulo solo lo usa a través de `window`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCart, saveCart } from "../lib/cart/storage.ts";
import { CART_STORAGE_KEY, EMPTY_CART, MAX_QTY } from "../lib/cart/types.ts";

const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const line = (over: Record<string, unknown> = {}) => ({
  productId: "11111111-1111-4111-8111-111111111111",
  slug: "concha",
  name: "Concha",
  variantLabel: null,
  unitPriceCents: 2500,
  qty: 1,
  imageUrl: null,
  categorySlug: "pan-dulce",
  ...over,
});
const put = (v: unknown) =>
  store.set(CART_STORAGE_KEY, typeof v === "string" ? v : JSON.stringify(v));

beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", { localStorage });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("carrito persistido (auditoría web)", () => {
  it("sin nada guardado → carrito vacío", () => {
    expect(loadCart()).toEqual(EMPTY_CART);
  });
  it("versión de esquema distinta o estructura corrupta → se reinicia sin lanzar", () => {
    put({ version: 2, lines: [line()] });
    expect(loadCart().lines).toEqual([]);
    put({ version: 1, lines: "no-es-array" });
    expect(loadCart().lines).toEqual([]);
    put("{json roto");
    expect(loadCart()).toEqual(EMPTY_CART);
    put("null");
    expect(loadCart()).toEqual(EMPTY_CART);
  });
  it("cantidades 0, negativas, decimales o no numéricas se descartan; 999 se recorta a MAX_QTY", () => {
    put({
      version: 1,
      lines: [
        line({ productId: "a", qty: 0 }),
        line({ productId: "b", qty: -3 }),
        line({ productId: "c", qty: 1.5 }),
        line({ productId: "d", qty: "2" }),
        line({ productId: "e", qty: 999 }),
        line({ productId: "f", qty: 2 }),
      ],
    });
    const c = loadCart();
    expect(c.lines.map((l) => [l.productId, l.qty])).toEqual([
      ["e", MAX_QTY],
      ["f", 2],
    ]);
  });
  it("líneas sin los campos mínimos o con precio no entero se descartan", () => {
    put({
      version: 1,
      lines: [
        { productId: "x", qty: 1 },
        line({ productId: "y", unitPriceCents: 12.5 }),
        line({ productId: "z", name: 42 }),
        line({ productId: "ok" }),
      ],
    });
    expect(loadCart().lines.map((l) => l.productId)).toEqual(["ok"]);
  });
  it("cupón sin código/descuento válido → null; notas se recortan a 500", () => {
    put({
      version: 1,
      lines: [line()],
      coupon: { code: 5, discountCents: 100 },
      notes: "x".repeat(600),
    });
    const c = loadCart();
    expect(c.coupon).toBeNull();
    expect(c.notes).toHaveLength(500);
    put({
      version: 1,
      lines: [line()],
      coupon: { code: "PROMO", kind: "pct", discountCents: 250 },
    });
    expect(loadCart().coupon).toEqual({ code: "PROMO", kind: "pct", discountCents: 250 });
  });
  it("guardar un carrito vacío borra la clave; con líneas la escribe", () => {
    saveCart({ ...EMPTY_CART, lines: [line()] });
    expect(store.has(CART_STORAGE_KEY)).toBe(true);
    saveCart(EMPTY_CART);
    expect(store.has(CART_STORAGE_KEY)).toBe(false);
  });
});
