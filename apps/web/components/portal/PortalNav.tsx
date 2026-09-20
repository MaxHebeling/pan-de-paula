"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/portal", label: "Inicio" },
  { href: "/portal/pedidos", label: "Pedidos" },
  { href: "/portal/compras", label: "Compras" },
  { href: "/portal/puntos", label: "Puntos" },
  { href: "/portal/perfil", label: "Perfil" },
];

/**
 * `sinLeer` llega del servidor en cada render, y `LiveOrders` fuerza un render nuevo cuando el
 * sondeo detecta un aviso: la campana se actualiza sola sin tener su propio temporizador.
 */
export function PortalNav({ sinLeer = 0 }: { sinLeer?: number }) {
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
        <li>
          <Link
            href="/portal/avisos"
            aria-current={pathname.startsWith("/portal/avisos") ? "page" : undefined}
            aria-label={sinLeer > 0 ? `Avisos, ${sinLeer} sin leer` : "Avisos"}
            className={`chip ${pathname.startsWith("/portal/avisos") ? "chip-active" : ""}`}
            data-testid="portal-nav-avisos"
          >
            <span aria-hidden>🔔</span>
            {sinLeer > 0 && (
              <span
                className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-wine px-1.5 text-xs leading-5 font-semibold text-white tabular-nums"
                data-testid="portal-avisos-badge"
              >
                {sinLeer > 99 ? "99+" : sinLeer}
              </span>
            )}
          </Link>
        </li>
      </ul>
    </nav>
  );
}
