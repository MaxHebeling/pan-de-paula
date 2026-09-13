/**
 * Dinero en centavos enteros (MXN). Nunca floats para cálculos.
 */
export type Cents = number;

export function assertCents(v: unknown, label = "monto"): asserts v is Cents {
  if (typeof v !== "number" || !Number.isInteger(v) || !Number.isFinite(v)) {
    throw new TypeError(`${label} debe ser un entero en centavos, recibido: ${String(v)}`);
  }
}

/**
 * Interpreta un monto capturado por una persona. Acepta punto o coma como separador decimal
 * ("45.50", "45,50"), separadores de miles ("1,234.56", "1.234,50") y símbolos ("$ 45.50").
 * Lanza si no hay dígitos o la forma es ambigua/inválida ("45.5.5", "abc").
 */
export function parseAmount(raw: string): number {
  let t = raw.trim().replace(/[^0-9.,-]/g, "");
  if (!/\d/.test(t)) throw new TypeError(`Monto inválido: ${raw}`);
  const hasDot = t.includes(".");
  const hasComma = t.includes(",");
  if (hasDot && hasComma) {
    // El separador que aparece al final es el decimal; el otro es de miles.
    const decimal = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    t = t.split(thousands).join("");
    if (decimal === ",") t = t.replace(",", ".");
  } else if (hasComma) {
    const parts = t.split(",");
    // "45,5" / "45,50" → decimal; "1,234" / "1,234,567" → miles.
    if (parts.length === 2 && parts[1]!.length > 0 && parts[1]!.length <= 2)
      t = `${parts[0]}.${parts[1]}`;
    else if (parts.slice(1).every((x) => x.length === 3)) t = parts.join("");
    else throw new TypeError(`Monto inválido: ${raw}`);
  } else if (hasDot) {
    const parts = t.split(".");
    // "1.234.567" → miles; "45.5.5" → inválido.
    if (parts.length > 2) {
      if (parts.slice(1).every((x) => x.length === 3)) t = parts.join("");
      else throw new TypeError(`Monto inválido: ${raw}`);
    }
  }
  const n = Number(t);
  if (!Number.isFinite(n)) throw new TypeError(`Monto inválido: ${raw}`);
  return n;
}

/** Convierte "45.50" | "45,50" | 45.5 → 4550. Redondeo half-up a centavos. */
export function toCents(amount: string | number): Cents {
  const n = typeof amount === "string" ? parseAmount(amount) : amount;
  if (!Number.isFinite(n)) throw new TypeError(`Monto inválido: ${amount}`);
  return Math.round(n * 100 + Number.EPSILON * Math.sign(n));
}

export function fromCents(cents: Cents): number {
  assertCents(cents);
  return cents / 100;
}

const fmt = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  minimumFractionDigits: 2,
});
const fmtNoDecimals = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

export function formatMXN(cents: Cents, opts: { compact?: boolean } = {}): string {
  assertCents(cents);
  if (opts.compact && cents % 100 === 0) return fmtNoDecimals.format(cents / 100);
  return fmt.format(cents / 100);
}

/** Redondeo half-up de un número (no float-safe para dinero; úsalo con proporciones). */
export function roundHalfUp(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n) + Number.EPSILON);
}

/** Porcentaje en basis points (1000 = 10%) aplicado a centavos, redondeo half-up. */
export function applyBps(cents: Cents, bps: number): Cents {
  assertCents(cents, "cents");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000)
    throw new RangeError(`bps fuera de rango: ${bps}`);
  return roundHalfUp((cents * bps) / 10000);
}

/** Reparte `total` en `n` partes enteras cuya suma es exacta (el residuo va a las primeras). */
export function splitCents(total: Cents, n: number): Cents[] {
  assertCents(total, "total");
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("n debe ser entero positivo");
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

export function sumCents(values: Iterable<Cents>): Cents {
  let s = 0;
  for (const v of values) {
    assertCents(v);
    s += v;
  }
  return s;
}
