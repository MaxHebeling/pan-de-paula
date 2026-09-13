import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_STORAGE_KEY,
  cartSignature,
  clearIdempotencyKey,
  getOrCreateIdempotencyKey,
  type StorageLike,
} from "../lib/checkout/idempotency.ts";

function memStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("clave de idempotencia del checkout (auditoría web)", () => {
  it("la misma firma de carrito reutiliza la misma clave tras un refresh", () => {
    const s = memStorage();
    let n = 0;
    const make = () => `web-key-${++n}`;
    const a = getOrCreateIdempotencyKey(s, "p1:2|p2:1", make);
    const b = getOrCreateIdempotencyKey(s, "p1:2|p2:1", make);
    expect(a).toBe("web-key-1");
    expect(b).toBe(a);
    expect(JSON.parse(s.data.get(IDEMPOTENCY_STORAGE_KEY)!)).toEqual({ key: a, sig: "p1:2|p2:1" });
  });
  it("cambiar el carrito genera una clave nueva", () => {
    const s = memStorage();
    let n = 0;
    const make = () => `web-key-${++n}`;
    const a = getOrCreateIdempotencyKey(s, "p1:2", make);
    const b = getOrCreateIdempotencyKey(s, "p1:3", make);
    expect(b).not.toBe(a);
    expect(getOrCreateIdempotencyKey(s, "p1:3", make)).toBe(b);
  });
  it("almacenamiento corrupto, ausente o que lanza: siempre devuelve una clave válida", () => {
    let n = 0;
    const make = () => `web-key-${++n}`;
    expect(
      getOrCreateIdempotencyKey(memStorage({ [IDEMPOTENCY_STORAGE_KEY]: "{no json" }), "x", make),
    ).toBe("web-key-1");
    expect(
      getOrCreateIdempotencyKey(
        memStorage({ [IDEMPOTENCY_STORAGE_KEY]: JSON.stringify({ key: "corta", sig: "x" }) }),
        "x",
        make,
      ),
    ).toBe("web-key-2");
    expect(getOrCreateIdempotencyKey(null, "x", make)).toBe("web-key-3");
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(getOrCreateIdempotencyKey(throwing, "x", make)).toBe("web-key-4");
    expect(() => clearIdempotencyKey(throwing)).not.toThrow();
  });
  it("la clave por defecto cumple el esquema del servidor (8–80 caracteres)", () => {
    const k = getOrCreateIdempotencyKey(memStorage(), "sig");
    expect(k.length).toBeGreaterThanOrEqual(8);
    expect(k.length).toBeLessThanOrEqual(80);
    expect(k.startsWith("web-")).toBe(true);
  });
  it("clear elimina la clave y la firma refleja producto y cantidad", () => {
    const s = memStorage();
    getOrCreateIdempotencyKey(s, "a:1");
    clearIdempotencyKey(s);
    expect(s.data.has(IDEMPOTENCY_STORAGE_KEY)).toBe(false);
    expect(
      cartSignature([
        { productId: "a", qty: 1 },
        { productId: "b", qty: 3 },
      ]),
    ).toBe("a:1|b:3");
    expect(cartSignature([])).toBe("");
  });
});
