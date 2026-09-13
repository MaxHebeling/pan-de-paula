/** Utilidades de texto seguras para búsquedas y exportaciones. */

/** Escapa los comodines de LIKE/ILIKE (`\`, `%`, `_`) para buscar el texto literal (escape por defecto de Postgres: `\`). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%término%` con comodines escapados, listo para `ilike`. */
export function containsPattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?$/;

/**
 * Celda CSV segura:
 * - comillas/separadores/saltos de línea → entre comillas dobles;
 * - protege contra inyección de fórmulas (CWE-1236): texto que empieza con = + - @ tab o CR se prefija con `'`,
 *   salvo que sea un número plano (p. ej. "-2" en correcciones de inventario).
 */
export function csvCell(value: unknown, separators = /[",;\n\r]/): string {
  let s =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s.trim())) s = `'${s}`;
  return separators.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
