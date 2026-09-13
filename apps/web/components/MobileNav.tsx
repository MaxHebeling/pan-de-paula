"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function MobileNav({ links }: { links: Array<{ href: string; label: string }> }) {
  const pathname = usePathname();
  // Se guarda la ruta en la que se abrió: al navegar a otra, el menú queda cerrado sin efectos.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="md:hidden">
      <button
        type="button"
        className="header-on-dark tap inline-flex items-center justify-center rounded-full text-ink hover:bg-cream-2"
        aria-expanded={open}
        aria-controls={open ? "mobile-menu" : undefined}
        aria-label={open ? "Cerrar menú" : "Abrir menú"}
        onClick={() => setOpenAt(open ? null : pathname)}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <nav
          id="mobile-menu"
          aria-label="Navegación principal"
          className="absolute inset-x-0 top-full border-t border-line bg-paper/95 shadow-soft backdrop-blur"
        >
          <ul className="container-x flex flex-col py-2">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={`block min-h-12 py-3 text-base ${pathname === l.href ? "font-semibold text-sage" : "text-ink"}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <Link href="/menu" className="btn btn-sage my-2 w-full">
                Pedir ahora
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </div>
  );
}
