import type { ReactNode } from "react";
import { Stat } from "@/components/ui";
import { delta } from "@/lib/reports";

/** Tarjeta de indicador con comparación contra el periodo anterior. */
export function CompareStat({
  label,
  value,
  current,
  previous,
  format,
  invert = false,
  hint,
}: {
  label: string;
  value: ReactNode;
  current: number;
  previous: number;
  format?: (v: number) => string;
  /** true cuando "menos es mejor" (mermas, reembolsos) */
  invert?: boolean;
  hint?: string;
}) {
  const d = delta(current, previous);
  const good = d === null ? undefined : d === 0 ? undefined : (d > 0) !== invert;
  const text = d === null ? "sin base anterior" : `${d > 0 ? "+" : ""}${d.toLocaleString("es-MX")}% vs. periodo anterior${format ? ` (${format(previous)})` : ""}`;
  return <Stat label={label} value={value} hint={hint ? `${hint} · ${text}` : text} tone={good === undefined ? undefined : good ? "green" : "red"} />;
}

export function Delta({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  const d = delta(current, previous);
  if (d === null) return <span className="text-xs text-muted">—</span>;
  const good = d === 0 ? undefined : (d > 0) !== invert;
  return (
    <span className={`text-xs tabular-nums ${good === undefined ? "text-muted" : good ? "text-green-d" : "text-red-d"}`}>
      {d > 0 ? "+" : ""}
      {d.toLocaleString("es-MX")}%
    </span>
  );
}

export function ReportHeading({ title, from, to, prevFrom, prevTo }: { title: string; from: string; to: string; prevFrom: string; prevTo: string }) {
  const f = (d: string) => new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"));
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted">
        {from === to ? f(from) : `${f(from)} – ${f(to)}`} · comparado con {prevFrom === prevTo ? f(prevFrom) : `${f(prevFrom)} – ${f(prevTo)}`}
      </p>
    </div>
  );
}
