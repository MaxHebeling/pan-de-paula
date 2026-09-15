"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({
  href,
  children,
  onNavigate,
}: {
  href: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const path = usePathname();
  const active = path === href || path.startsWith(href + "/");
  return (
    <Link
      href={href}
      prefetch={false}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex items-center gap-2.5 rounded-[var(--r-btn)] px-3 py-2 text-sm font-medium transition ${active ? "bg-teal text-white" : "text-ink hover:bg-black/5"}`}
    >
      {children}
    </Link>
  );
}
