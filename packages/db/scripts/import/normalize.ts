/** Normalización de nombres y similitud simple (trigramas) para detectar posibles duplicados. */

/** minúsculas, sin acentos, sin signos, espacios colapsados. "Croissant  de Mantequilla " → "croissant de mantequilla" */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s: string): Map<string, number> {
  const padded = `  ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < padded.length - 2; i++) {
    const t = padded.slice(i, i + 3);
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/** Coeficiente de Dice sobre trigramas (0–1). 1 = idénticos. */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) return 0;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [t, n] of ta) {
    totalA += n;
    const nb2 = tb.get(t);
    if (nb2) inter += Math.min(n, nb2);
  }
  for (const n of tb.values()) totalB += n;
  return (2 * inter) / (totalA + totalB);
}

export type Candidate<T> = { item: T; score: number };

/** Mejor coincidencia similar (no exacta) por encima del umbral. */
export function findSimilar<T>(
  name: string,
  items: Iterable<T>,
  getName: (t: T) => string,
  threshold: number,
): Candidate<T> | null {
  let best: Candidate<T> | null = null;
  const n = normalizeName(name);
  for (const item of items) {
    const other = normalizeName(getName(item));
    if (other === n) continue;
    const score = similarity(n, other);
    if (score >= threshold && (!best || score > best.score)) best = { item, score };
  }
  return best;
}
