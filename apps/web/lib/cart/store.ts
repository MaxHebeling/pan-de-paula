/** Store externo del carrito (useSyncExternalStore): hidratación segura, persistencia y sync entre pestañas sin efectos. */
import { loadCart, saveCart } from "./storage";
import {
  CART_STORAGE_KEY,
  EMPTY_CART,
  MAX_QTY,
  type CartCoupon,
  type CartLine,
  type CartState,
} from "./types";

let state: CartState = EMPTY_CART;
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function onStorage(e: StorageEvent) {
  if (e.key === CART_STORAGE_KEY || e.key === null) {
    state = loadCart();
    emit();
  }
}

export function getSnapshot(): CartState {
  if (!loaded && typeof window !== "undefined") {
    state = loadCart();
    loaded = true;
  }
  return state;
}

export function getServerSnapshot(): CartState {
  return EMPTY_CART;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function update(fn: (s: CartState) => CartState) {
  state = fn(getSnapshot());
  saveCart(state);
  emit();
}

export const cartStore = {
  add(line: Omit<CartLine, "qty">, qty: number) {
    update((s) => {
      const existing = s.lines.find((l) => l.productId === line.productId);
      const lines = existing
        ? s.lines.map((l) =>
            l.productId === line.productId
              ? { ...l, ...line, qty: Math.min(MAX_QTY, l.qty + qty) }
              : l,
          )
        : [...s.lines, { ...line, qty: Math.min(MAX_QTY, qty) }];
      return { ...s, lines };
    });
  },
  setQty(productId: string, qty: number) {
    update((s) =>
      qty <= 0
        ? { ...s, lines: s.lines.filter((l) => l.productId !== productId) }
        : {
            ...s,
            lines: s.lines.map((l) =>
              l.productId === productId ? { ...l, qty: Math.min(MAX_QTY, qty) } : l,
            ),
          },
    );
  },
  remove(productId: string) {
    update((s) => ({ ...s, lines: s.lines.filter((l) => l.productId !== productId) }));
  },
  clear() {
    update(() => ({ ...EMPTY_CART }));
  },
  setNotes(notes: string) {
    update((s) => ({ ...s, notes: notes.slice(0, 500) }));
  },
  setCoupon(coupon: CartCoupon | null) {
    update((s) => ({ ...s, coupon }));
  },
  setCustomerLookup(value: string | null) {
    update((s) => ({ ...s, customerLookup: value }));
  },
};
