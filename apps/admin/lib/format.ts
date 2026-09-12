import { formatMXN } from "@pdp/domain";

export const money = (cents: number | string | null | undefined, opts?: { compact?: boolean }) =>
  cents === null || cents === undefined
    ? "—"
    : formatMXN(typeof cents === "string" ? Number(cents) : cents, opts);

const TZ = process.env.BUSINESS_TZ ?? "America/Tijuana";

export function fmtDate(
  d: Date | string | null | undefined,
  style: "short" | "long" | "time" | "datetime" = "short",
): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const o: Intl.DateTimeFormatOptions =
    style === "short"
      ? { day: "2-digit", month: "short" }
      : style === "long"
        ? { weekday: "long", day: "numeric", month: "long" }
        : style === "time"
          ? { hour: "2-digit", minute: "2-digit" }
          : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("es-MX", { timeZone: TZ, ...o }).format(date);
}

export function qty(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("es-MX", { maximumFractionDigits: 3 });
}

export function pct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return (bps / 100).toLocaleString("es-MX", { maximumFractionDigits: 1 }) + "%";
}

/** Fecha local (YYYY-MM-DD) del negocio para "hoy". */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
