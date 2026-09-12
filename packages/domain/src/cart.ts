/** Cálculo de totales del carrito (previsualización en cliente; el servidor recalcula siempre). */
import { applyBps, roundHalfUp, type Cents } from "./money.ts";

export type CartLine = {
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: Cents;
  discountCents?: Cents;
};
export type CartDiscount =
  | { kind: "pct"; valueBps: number; productId?: string | null }
  | { kind: "amount"; valueCents: Cents }
  | { kind: "free_product"; productId: string };

export type CartTotals = {
  subtotalCents: Cents;
  discountCents: Cents;
  deliveryFeeCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
  itemsCount: number;
};

export function lineTotal(l: CartLine): Cents {
  return Math.max(roundHalfUp(l.unitPriceCents * l.qty) - (l.discountCents ?? 0), 0);
}

export function discountFor(lines: CartLine[], subtotal: Cents, d: CartDiscount | null): Cents {
  if (!d) return 0;
  let disc: number;
  if (d.kind === "pct") {
    const base = d.productId
      ? lines.filter((l) => l.productId === d.productId).reduce((s, l) => s + lineTotal(l), 0)
      : subtotal;
    disc = applyBps(base, d.valueBps);
  } else if (d.kind === "amount") {
    disc = Math.min(d.valueCents, subtotal);
  } else {
    const prices = lines.filter((l) => l.productId === d.productId).map((l) => l.unitPriceCents);
    disc = prices.length ? Math.min(...prices) : 0;
  }
  return Math.min(Math.max(disc, 0), subtotal);
}

export function cartTotals(
  lines: CartLine[],
  opts: {
    discounts?: CartDiscount[];
    deliveryFeeCents?: Cents;
    tipCents?: Cents;
    taxRateBps?: number;
    pricesIncludeTax?: boolean;
  } = {},
): CartTotals {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  let discount = 0;
  for (const d of opts.discounts ?? []) discount += discountFor(lines, subtotal, d);
  discount = Math.min(discount, subtotal);
  const fee = opts.deliveryFeeCents ?? 0;
  const tip = opts.tipCents ?? 0;
  const tax =
    !opts.pricesIncludeTax && (opts.taxRateBps ?? 0) > 0
      ? applyBps(subtotal - discount, opts.taxRateBps!)
      : 0;
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    deliveryFeeCents: fee,
    taxCents: tax,
    tipCents: tip,
    totalCents: subtotal - discount + fee + tax + tip,
    itemsCount: lines.reduce((s, l) => s + l.qty, 0),
  };
}

/** Cambio a entregar en efectivo. */
export function changeDue(totalCents: Cents, tenderedCents: Cents): Cents {
  if (tenderedCents < totalCents) throw new RangeError("Efectivo insuficiente");
  return tenderedCents - totalCents;
}

/** Sugerencias rápidas de billetes para el POS. */
export function quickTenderOptions(totalCents: Cents): Cents[] {
  const steps = [2000, 5000, 10000, 20000, 50000, 100000];
  const out = new Set<Cents>([totalCents]);
  for (const s of steps) {
    const rounded = Math.ceil(totalCents / s) * s;
    if (rounded > totalCents) out.add(rounded);
    if (out.size >= 4) break;
  }
  return [...out].sort((a, b) => a - b);
}
