import Link from "next/link";
import { CartButton } from "./CartButton";
import { HeaderShell } from "./HeaderShell";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";

export const NAV_LINKS = [
  { href: "/menu", label: "Menú" },
  { href: "/club", label: "Club" },
  { href: "/horarios", label: "Horarios" },
  { href: "/ubicacion", label: "Ubicación" },
  { href: "/nosotros", label: "Nosotros" },
];

export function Header() {
  return (
    <HeaderShell>
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-pill focus:bg-ink focus:px-4 focus:py-2 focus:text-cream"
      >
        Saltar al contenido
      </a>
      <div className="container-x relative flex h-16 items-center justify-between gap-3 sm:h-[72px]">
        <Link href="/" className="flex items-center gap-3" aria-label="El Pan de Paula, inicio">
          <Logo size={44} priority />
          <span className="header-on-dark hidden font-display text-lg leading-none text-ink sm:block">
            El Pan de Paula
          </span>
        </Link>
        <nav aria-label="Navegación principal" className="header-nav-enter hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="header-on-dark btn btn-ghost px-3.5 text-[15px]">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-1">
          <Link href="/menu" className="header-nav-enter btn btn-sage hidden px-4 sm:inline-flex">
            Pedir ahora
          </Link>
          <CartButton />
          <MobileNav links={NAV_LINKS} />
        </div>
      </div>
    </HeaderShell>
  );
}
