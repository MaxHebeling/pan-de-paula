"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { PrintButton } from "./print-button";

type Kind = { key: string; label: string; href: string };

function shift(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Pestañas de reportes + selector de rango (fechas locales) + exportar/imprimir. */
export function RangeBar({
  kinds,
  today,
  from,
  to,
  canExport,
  reportKey,
  exportParams = "",
}: {
  kinds: Kind[];
  today: string;
  from: string;
  to: string;
  canExport: boolean;
  reportKey: string;
  /** Filtros extra del reporte (ya codificados, p. ej. "&metodo=transfer&ref=BANORTE") para que el CSV salga igual que la pantalla. */
  exportParams?: string;
}) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = `?from=${from}&to=${to}`;
  const monthStart = today.slice(0, 8) + "01";
  const [y, m] = today.split("-").map(Number) as [number, number];
  const prevMonthStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();
  const weekStart = shift(today, -((weekday + 6) % 7));
  const presets: Array<[string, string, string]> = [
    ["Hoy", today, today],
    ["Ayer", shift(today, -1), shift(today, -1)],
    ["Esta semana", weekStart, today],
    ["Este mes", monthStart, today],
    ["Mes anterior", prevMonthStart, shift(monthStart, -1)],
    ["30 días", shift(today, -29), today],
    ["90 días", shift(today, -89), today],
  ];
  const isActive = (f: string, t: string) => sp.get("from") === f && sp.get("to") === t;
  return (
    <div className="no-print mb-4 flex flex-col gap-3">
      <nav className="flex flex-wrap gap-2" aria-label="Reportes">
        {kinds.map((k) => (
          <Link
            key={k.key}
            href={`${k.href}${qs}`}
            aria-current={pathname === k.href ? "page" : undefined}
            className={`pill px-3 py-1.5 text-sm font-medium ${pathname === k.href ? "bg-teal text-white" : "st-gray"}`}
          >
            {k.label}
          </Link>
        ))}
      </nav>
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <form className="flex flex-wrap items-end gap-2" method="get" action={pathname}>
          <div>
            <label className="label" htmlFor="from">
              Desde
            </label>
            <input
              id="from"
              name="from"
              type="date"
              className="input"
              defaultValue={from}
              max={today}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="to">
              Hasta
            </label>
            <input
              id="to"
              name="to"
              type="date"
              className="input"
              defaultValue={to}
              max={today}
              required
            />
          </div>
          <button className="btn btn-primary">Aplicar</button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {presets.map(([label, f, t]) => (
            <Link
              key={label}
              href={`${pathname}?from=${f}&to=${t}`}
              className={`pill px-2.5 py-1 text-xs font-medium ${isActive(f, t) ? "bg-teal text-white" : "st-gray"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {canExport && (
            <a
              className="btn btn-secondary"
              href={`/api/reports/export?report=${reportKey}&from=${from}&to=${to}&format=csv${exportParams}`}
              download
            >
              <Download size={16} aria-hidden /> CSV
            </a>
          )}
          <PrintButton />
        </div>
      </div>
    </div>
  );
}
