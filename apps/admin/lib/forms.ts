import "server-only";
import { z } from "zod";
import { toCents } from "@pdp/domain";
import { dbErrorMessage } from "@pdp/db";
import type { ActionState } from "./action-state";

/** Lectores de FormData tolerantes: cadenas vacías → undefined / null según convenga al esquema zod. */
export function str(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function strOrNull(form: FormData, key: string): string | null {
  return str(form, key) ?? null;
}

export function bool(form: FormData, key: string): boolean {
  const v = form.get(key);
  return v === "on" || v === "true" || v === "1";
}

export function num(form: FormData, key: string): number | undefined {
  const s = str(form, key);
  if (s === undefined) return undefined;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

/** "45.50" → 4550. Devuelve undefined si está vacío, NaN si es inválido (zod lo reporta). */
export function cents(form: FormData, key: string): number | undefined {
  const s = str(form, key);
  if (s === undefined) return undefined;
  try {
    return toCents(s);
  } catch {
    return NaN;
  }
}

/** Lista separada por comas o saltos de línea, sin vacíos ni duplicados. */
export function list(form: FormData, key: string): string[] {
  const s = form.get(key);
  if (typeof s !== "string") return [];
  return Array.from(
    new Set(
      s
        .split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  );
}

export function uuidOrNull(form: FormData, key: string): string | null {
  const s = str(form, key);
  return s && z.uuid().safeParse(s).success ? s : null;
}

/** Primer error zod en español legible para el formulario. */
export function zodMessage(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "Datos inválidos";
  const path = i.path.length ? `${String(i.path.join("."))}: ` : "";
  return `${path}${i.message}`;
}

/** Convierte cualquier excepción en ActionState seguro y deja rastro en el log del servidor. */
export function failure(context: string, e: unknown): ActionState {
  const { message, code } = dbErrorMessage(e);
  console.error(`[admin:${context}]`, code ?? "", message, e instanceof Error ? e.stack : "");
  return { error: message };
}

export const zId = z.uuid("Identificador inválido");
export const zCents = z
  .number({ error: "Escribe un monto válido" })
  .int()
  .nonnegative("El monto no puede ser negativo")
  .max(100_000_000, "Monto demasiado grande");
export const zQty = z
  .number({ error: "Escribe una cantidad válida" })
  .positive("Debe ser mayor a cero")
  .max(1_000_000_000);
export const zTime = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Hora inválida (HH:MM)")
  .optional()
  .nullable();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");
