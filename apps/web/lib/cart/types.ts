export type CartLine = {
  productId: string;
  slug: string;
  name: string;
  variantLabel: string | null;
  unitPriceCents: number;
  qty: number;
  imageUrl: string | null;
  categorySlug: string | null;
};

export type CartCoupon = {
  code: string;
  kind: "pct" | "amount" | "free_product";
  discountCents: number;
};

export type CartState = {
  version: 1;
  lines: CartLine[];
  coupon: CartCoupon | null;
  notes: string;
  customerLookup: string | null;
};

export const CART_STORAGE_KEY = "pdp.cart.v1";
export const EMPTY_CART: CartState = { version: 1, lines: [], coupon: null, notes: "", customerLookup: null };
export const MAX_QTY = 50;
