import Link from "next/link";

export type TabItem = { key: string; label: string; count?: number };

/** Pestañas por query string (?tab=…), navegables sin JS y táctiles (≥44px). */
export function Tabs({
  base,
  current,
  items,
  param = "tab",
  keep = {},
}: {
  base: string;
  current: string;
  items: TabItem[];
  param?: string;
  keep?: Record<string, string | undefined>;
}) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto rounded-[var(--r-card)] bg-black/5 p-1" aria-label="Secciones">
      {items.map((t) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(keep)) if (v) params.set(k, v);
        params.set(param, t.key);
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={`${base}?${params.toString()}`}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded-[var(--r-btn-sm)] px-4 text-sm font-semibold transition ${
              active ? "bg-card text-ink shadow-[var(--shadow)]" : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className={`pill px-2 py-0.5 text-[11px] ${active ? "bg-teal text-white" : "bg-black/10 text-ink"}`}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
