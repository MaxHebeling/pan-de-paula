/**
 * Redacción de datos sensibles, sin dependencias (válido en servidor, edge y navegador).
 * Usado por el logger estructurado y por el `beforeSend` de Sentry.
 */
export const SENSITIVE_KEY =
  /(pass(word|wd)?|secret|token|authorization|auth|cookie|set-cookie|api[-_]?key|access[-_]?key|private[-_]?key|signature|x-signature|card|cvv|cvc|pan\b|session)/i;

export const REDACTED = "[REDACTED]";

/** Devuelve una copia del valor con las claves sensibles redactadas (profundidad máx. 8). */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[depth]" as unknown as T;
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...redact(errorExtras(value), depth + 1),
    } as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  if (typeof value === "string") return redactString(value) as unknown as T;
  return value;
}

function errorExtras(e: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(e)) out[k] = (e as unknown as Record<string, unknown>)[k];
  return out;
}

/** Oculta tokens tipo Bearer, "sk-…", "APP_USR-…", "re_…" incrustados en texto libre. */
export function redactString(s: string): string {
  if (s.length < 12) return s;
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(APP_USR|TEST|EAA|sk-ant|re_)[-_A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\b\d{13,19}\b/g, (m) => (luhn(m) ? REDACTED : m));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Redacta los parámetros sensibles de una URL (`?access_token=…&token=…`) conservando el resto. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return redactString(url);
  const hashAt = url.indexOf("#", q);
  const base = url.slice(0, q);
  const query = url.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  return `${base}?${redactQueryString(query)}${hash}`;
}

/** Redacta un query string en cualquiera de las formas que usa Sentry: texto, pares o registro. */
export function redactQueryString<T>(qs: T): T {
  if (typeof qs === "string") {
    return qs
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        let key = pair.slice(0, eq);
        try {
          key = decodeURIComponent(key);
        } catch {
          // clave mal codificada: se evalúa tal cual
        }
        return SENSITIVE_KEY.test(key)
          ? `${pair.slice(0, eq)}=${encodeURIComponent(REDACTED)}`
          : redactString(pair);
      })
      .join("&") as unknown as T;
  }
  if (Array.isArray(qs))
    return qs.map((p) =>
      Array.isArray(p) && typeof p[0] === "string" && SENSITIVE_KEY.test(p[0])
        ? [p[0], REDACTED]
        : p,
    ) as unknown as T;
  return redact(qs);
}
