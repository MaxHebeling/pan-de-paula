import { CART_STORAGE_KEY, EMPTY_CART, MAX_QTY, type CartState } from "./types";

function isLine(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l.productId === "string" &&
    typeof l.slug === "string" &&
    typeof l.name === "string" &&
    Number.isInteger(l.qty) &&
    (l.qty as number) > 0 &&
    Number.isInteger(l.unitPriceCents)
  );
}

/** Lee el carrito del navegador; descarta versiones viejas o datos corruptos. */
export function loadCart(): CartState {
  if (typeof window === "undefined") return EMPTY_CART;
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return EMPTY_CART;
    const parsed = JSON.parse(raw) as Partial<CartState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.lines)) return EMPTY_CART;
    const lines = parsed.lines.filter(isLine).map((l) => ({
      productId: l.productId,
      slug: l.slug,
      name: l.name,
      variantLabel: l.variantLabel ?? null,
      unitPriceCents: l.unitPriceCents,
      qty: Math.min(MAX_QTY, l.qty),
      imageUrl: l.imageUrl ?? null,
      categorySlug: l.categorySlug ?? null,
    }));
    return {
      version: 1,
      lines,
      coupon:
        parsed.coupon && typeof parsed.coupon.code === "string" && Number.isInteger(parsed.coupon.discountCents)
          ? parsed.coupon
          : null,
      notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 500) : "",
      customerLookup: typeof parsed.customerLookup === "string" ? parsed.customerLookup : null,
    };
  } catch (e) {
    console.warn("[cart] no se pudo leer el carrito guardado; se reinicia", e);
    return EMPTY_CART;
  }
}

export function saveCart(state: CartState): void {
  if (typeof window === "undefined") return;
  try {
    if (state.lines.length === 0 && !state.notes && !state.customerLookup) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
    } else {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state));
    }
  } catch (e) {
    console.warn("[cart] no se pudo guardar el carrito", e);
  }
}
