"use client";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { NavLink } from "./nav-link";
import { Icon } from "./icon";
import { GlobalSearch } from "./search/global-search";
import { NAV_GROUPS, type NavItem } from "@/lib/nav";

export function Shell({
  items,
  user,
  unread,
  children,
}: {
  items: NavItem[];
  user: { name: string; role: string };
  unread: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const groups = Object.entries(NAV_GROUPS) as Array<[NavItem["group"], string]>;
  const nav = (
    <nav className="flex flex-col gap-4 p-3" aria-label="Principal">
      {groups.map(([g, label]) => {
        const its = items.filter((i) => i.group === g);
        if (!its.length) return null;
        return (
          <div key={g}>
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {label}
            </div>
            <div className="flex flex-col gap-0.5">
              {its.map((i) => (
                <NavLink key={i.href} href={i.href} onNavigate={() => setOpen(false)}>
                  <Icon name={i.icon} />
                  <span>{i.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      <aside className="glass sticky top-0 hidden h-dvh overflow-y-auto border-r border-line md:block">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <Image src="/logo.png" alt="" width={36} height={36} className="rounded-full" />
          <div>
            <div className="text-sm font-semibold leading-tight">El Pan de Paula</div>
            <div className="text-[11px] text-muted">Sistema operativo</div>
          </div>
        </div>
        {nav}
      </aside>
      <div className="flex min-h-dvh flex-col">
        <header className="glass sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line px-3 py-2 md:px-6">
          <button
            className="btn btn-secondary btn-sm md:hidden"
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
          >
            <Icon name="☰" size={20} />
          </button>
          <div className="hidden text-sm text-muted md:block">
            Hola, <span className="font-medium text-ink">{user.name}</span> · {user.role}
          </div>
          <div className="flex items-center gap-1.5">
            <GlobalSearch />
            <Link
              href="/notificaciones"
              className="btn btn-secondary btn-sm relative"
              aria-label={`Notificaciones (${unread} sin leer)`}
            >
              <Icon name="🔔" />
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 rounded-full bg-red px-1.5 text-[10px] font-bold text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <form action="/api/auth/logout" method="post">
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                <Icon name="🚪" />
              </button>
            </form>
          </div>
        </header>
        <main className="flex-1 px-3 py-4 md:px-6 md:py-6">{children}</main>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="glass absolute inset-y-0 left-0 w-[280px] overflow-y-auto shadow-lift">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="font-semibold">Menú</span>
              <button
                className="btn btn-secondary btn-sm"
                aria-label="Cerrar menú"
                onClick={() => setOpen(false)}
              >
                <Icon name="✕" size={16} />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}
    </div>
  );
}
