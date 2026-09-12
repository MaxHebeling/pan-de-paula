import Link from "next/link";

/** Pestañas por enlace (server-friendly): cada pestaña es una URL, navegable con teclado y compartible. */
export function LinkTabs({ items }: { items: Array<{ href: string; label: string; active: boolean }> }) {
  return (
    <nav aria-label="Secciones" className="mb-4 -mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-line px-1">
        {items.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              aria-current={t.active ? "page" : undefined}
              className={`inline-block border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                t.active
                  ? "border-teal text-teal-d"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
