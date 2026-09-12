"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cartTotals, type CartTotals } from "@pdp/domain";
import { validateCouponAction } from "@/app/carrito/actions";
import { cartStore, getServerSnapshot, getSnapshot, subscribe } from "./store";
import type { CartCoupon, CartLine } from "./types";

export type CartContextValue = {
  lines: CartLine[];
  coupon: CartCoupon | null;
  couponError: string | null;
  couponBusy: boolean;
  notes: string;
  customerLookup: string | null;
  hydrated: boolean;
  count: number;
  totals: CartTotals;
  isOpen: boolean;
  lastAddedAt: number;
  open: () => void;
  close: () => void;
  add: (line: Omit<CartLine, "qty">, qty?: number) => void;
  setQty: (productId: string, qty: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  setNotes: (notes: string) => void;
  setCustomerLookup: (v: string | null) => void;
  applyCoupon: (code: string) => Promise<boolean>;
  removeCoupon: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);
const noopSubscribe = () => () => {};

export function CartProvider({ children }: { children: React.ReactNode }) {
  // El estado vive en un store externo: el servidor ve un carrito vacío y el cliente hidrata sin efectos.
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [isOpen, setOpen] = useState(false);
  const [lastAddedAt, setLastAddedAt] = useState(0);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const seq = useRef(0);

  const runCouponValidation = useCallback(
    async (code: string, lines: CartLine[], customerLookup: string | null): Promise<boolean> => {
      const mySeq = ++seq.current;
      setCouponBusy(true);
      setCouponError(null);
      try {
        const r = await validateCouponAction({
          code,
          items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
          customerLookup,
        });
        if (mySeq !== seq.current) return false;
        if (r.ok) {
          cartStore.setCoupon({ code: r.code, kind: r.kind, discountCents: r.discountCents });
          return true;
        }
        cartStore.setCoupon(null);
        setCouponError(r.error);
        return false;
      } catch (e) {
        console.error("[cart] validación de cupón falló", e);
        if (mySeq === seq.current) setCouponError("No pudimos validar el cupón. Intenta de nuevo.");
        return false;
      } finally {
        if (mySeq === seq.current) setCouponBusy(false);
      }
    },
    [],
  );

  // El descuento depende del contenido: al cambiar líneas se revalida (con pequeño debounce) en el servidor.
  const linesKey = state.lines.map((l) => `${l.productId}:${l.qty}`).join("|");
  const couponCode = state.coupon?.code ?? null;
  const customerLookup = state.customerLookup;
  useEffect(() => {
    if (!hydrated || !couponCode) return;
    const t = window.setTimeout(() => {
      const current = getSnapshot();
      if (current.lines.length === 0) {
        cartStore.setCoupon(null);
        return;
      }
      void runCouponValidation(couponCode, current.lines, current.customerLookup);
    }, 250);
    return () => window.clearTimeout(t);
  }, [linesKey, couponCode, customerLookup, hydrated, runCouponValidation]);

  const totals = useMemo(
    () =>
      cartTotals(
        state.lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          qty: l.qty,
          unitPriceCents: l.unitPriceCents,
        })),
        {
          discounts: state.coupon
            ? [{ kind: "amount", valueCents: state.coupon.discountCents }]
            : [],
        },
      ),
    [state.lines, state.coupon],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      lines: state.lines,
      coupon: state.coupon,
      couponError,
      couponBusy,
      notes: state.notes,
      customerLookup: state.customerLookup,
      hydrated,
      count: state.lines.reduce((s, l) => s + l.qty, 0),
      totals,
      isOpen,
      lastAddedAt,
      open: () => setOpen(true),
      close: () => setOpen(false),
      add: (line, qty = 1) => {
        cartStore.add(line, qty);
        setLastAddedAt(Date.now());
        setOpen(true);
      },
      setQty: cartStore.setQty,
      remove: cartStore.remove,
      clear: () => {
        seq.current++;
        cartStore.clear();
        setCouponError(null);
        setCouponBusy(false);
      },
      setNotes: cartStore.setNotes,
      setCustomerLookup: cartStore.setCustomerLookup,
      applyCoupon: (code) =>
        runCouponValidation(code, getSnapshot().lines, getSnapshot().customerLookup),
      removeCoupon: () => {
        seq.current++;
        setCouponBusy(false);
        setCouponError(null);
        cartStore.setCoupon(null);
      },
    }),
    [state, hydrated, totals, isOpen, lastAddedAt, couponError, couponBusy, runCouponValidation],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart debe usarse dentro de <CartProvider>");
  return ctx;
}
