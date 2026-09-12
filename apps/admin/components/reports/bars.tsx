/** Barras horizontales en CSS (sin librerías de gráficas). */
export function Bars({
  items,
  format,
  tone = "teal",
}: {
  items: Array<{ label: string; value: number; hint?: string }>;
  format?: (v: number) => string;
  tone?: "teal" | "amber" | "red" | "green";
}) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  const color = { teal: "bg-teal", amber: "bg-amber", red: "bg-red", green: "bg-green" }[tone];
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(70px,1fr)_3fr_auto] items-center gap-2">
          <span className="truncate text-muted" title={i.label}>
            {i.label}
          </span>
          <div className="h-3 overflow-hidden rounded-full bg-black/[0.05]" aria-hidden>
            <div
              className={`h-full rounded-full ${color}`}
              style={{ width: `${Math.round((Math.abs(i.value) / max) * 100)}%` }}
            />
          </div>
          <span className="tabular-nums" title={i.hint}>
            {format ? format(i.value) : i.value.toLocaleString("es-MX")}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Columnas verticales compactas (serie temporal). */
export function Columns({
  items,
  format,
  height = 96,
}: {
  items: Array<{ label: string; value: number }>;
  format?: (v: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div
      className="flex items-end gap-[3px] overflow-x-auto"
      style={{ height }}
      role="img"
      aria-label="Serie"
    >
      {items.map((i) => (
        <div
          key={i.label}
          className="group relative flex min-w-[6px] flex-1 flex-col justify-end"
          style={{ height: "100%" }}
          title={`${i.label}: ${format ? format(i.value) : i.value}`}
        >
          <div
            className="rounded-t bg-teal/80 group-hover:bg-teal"
            style={{ height: `${Math.max(2, Math.round((i.value / max) * 100))}%` }}
          />
        </div>
      ))}
    </div>
  );
}
