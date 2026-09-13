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

import { REDACTED, redact } from "@pdp/domain";

export { REDACTED, redact };

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
