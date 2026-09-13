import type { ReactNode } from "react";
import type { FormulaLine, FormulaTone } from "./formula-lines";

/**
 * Fórmula visible "como hoja de cálculo": etiqueta = expresión con valores = resultado.
 * Sin hooks: sirve en server components y dentro de componentes cliente.
 */

const TONE: Record<FormulaTone, string> = {
  green: "text-green-d",
  amber: "text-amber-d",
  red: "text-red-d",
  muted: "text-muted",
};

export function Formula({ line, compact = false }: { line: FormulaLine; compact?: boolean }) {
  const tone = line.tone ? TONE[line.tone] : "";
  return (
    <div
      className={`grid gap-x-2 tabular-nums ${compact ? "text-xs" : "text-sm"} sm:grid-cols-[minmax(7rem,auto)_1fr]`}
      data-formula={line.key}
    >
      <dt className="font-medium text-ink">{line.label}</dt>
      <dd className="min-w-0">
        <span className="text-muted">= </span>
        <span className="break-words font-mono text-[0.95em]">{line.expr}</span>
        <span className="text-muted"> = </span>
        <strong className={`font-semibold ${tone}`}>{line.result}</strong>
        {line.note && <span className={`ml-1 text-xs ${tone || "text-muted"}`}>({line.note})</span>}
      </dd>
    </div>
  );
}

export function FormulaList({
  lines,
  compact,
  className = "",
  ariaLive,
}: {
  lines: FormulaLine[];
  compact?: boolean;
  className?: string;
  ariaLive?: "polite" | "off";
}) {
  return (
    <dl className={`flex flex-col gap-1 ${className}`} aria-live={ariaLive}>
      {lines.map((l) => (
        <Formula key={l.key} line={l} compact={compact} />
      ))}
    </dl>
  );
}

/** Fórmulas plegadas tras un resumen (para filas de tablas). */
export function FormulaDetails({
  summary,
  lines,
  className = "",
  defaultOpen = false,
}: {
  summary: ReactNode;
  lines: FormulaLine[];
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={`group ${className}`} open={defaultOpen || undefined}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-[var(--r-btn-sm)] px-1 text-xs text-teal-d hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="transition-transform group-open:rotate-90">
          ▸
        </span>
        {summary}
      </summary>
      <div className="mt-1 rounded-[var(--r-card)] bg-black/[0.03] px-3 py-2">
        <FormulaList lines={lines} compact />
      </div>
    </details>
  );
}
