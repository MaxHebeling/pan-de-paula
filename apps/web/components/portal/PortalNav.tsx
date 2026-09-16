"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/portal", label: "Inicio" },
  { href: "/portal/compras", label: "Compras" },
  { href: "/portal/puntos", label: "Puntos" },
  { href: "/portal/perfil", label: "Perfil" },
];

export function PortalNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Secciones de mi cuenta" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-2">
        {LINKS.map((l) => {
          const active =
            l.href === "/portal" ? pathname === "/portal" : pathname.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`chip ${active ? "chip-active" : ""}`}
                data-testid={`portal-nav-${l.label.toLowerCase()}`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
