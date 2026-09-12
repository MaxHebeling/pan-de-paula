/**
 * Logger estructurado (JSON por línea) para servidor.
 * - Niveles: debug < info < warn < error (LOG_LEVEL, default info).
 * - Redacta claves sensibles (password, token, secret, card, authorization, cookie, api_key…)
 *   de forma recursiva antes de serializar. Nunca imprime secretos.
 * - Sin dependencias. Compatible con Vercel / Node / tests.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
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
function redactString(s: string): string {
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

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

type Sink = (line: string, level: LogLevel) => void;
let sink: Sink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
};

/** Solo para tests: captura las líneas emitidas. */
export function _setLogSink(s: Sink | null) {
  sink =
    s ??
    ((line, level) => {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.info(line);
    });
}

function emit(level: LogLevel, scope: string | undefined, msg: string, fields?: LogFields) {
  if (LEVELS[level] < currentLevel()) return;
  const rec: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    ...(scope ? { scope } : {}),
    msg,
    env: process.env.APP_ENV ?? "development",
  };
  if (fields) Object.assign(rec, redact(fields));
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ time: rec.time, level, scope, msg, serializeError: true });
  }
  sink(line, level);
}

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (scope: string) => Logger;
};

export function createLogger(scope?: string): Logger {
  return {
    debug: (m, f) => emit("debug", scope, m, f),
    info: (m, f) => emit("info", scope, m, f),
    warn: (m, f) => emit("warn", scope, m, f),
    error: (m, f) => emit("error", scope, m, f),
    child: (s) => createLogger(scope ? `${scope}.${s}` : s),
  };
}

export const logger = createLogger();
