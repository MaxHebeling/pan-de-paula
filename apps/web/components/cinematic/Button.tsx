import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Sistema de botones del home: PRIMARY (acción principal), SECONDARY (alternativa) y TEXT LINK.
 * La flecha avanza 4 px al pasar el puntero. `magnetic` (3–6 px, solo desktop) únicamente en CTA grandes:
 * lo aplica lib/motion/magnetic.ts sobre `[data-magnetic]`.
 */
type Variant = "primary" | "secondary" | "text";

export function Arrow({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="cin-arrow"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

export function CinLink({
  href,
  variant = "primary",
  children,
  magnetic = false,
  arrow = true,
  className = "",
  testId,
}: {
  href: string;
  variant?: Variant;
  children: ReactNode;
  magnetic?: boolean;
  arrow?: boolean;
  className?: string;
  testId?: string;
}) {
  const cls =
    variant === "text"
      ? "cin-link"
      : `cin-btn ${variant === "primary" ? "cin-btn-primary" : "cin-btn-secondary"}`;
  return (
    <Link
      href={href}
      className={`${cls} ${className}`}
      data-magnetic={magnetic ? "" : undefined}
      data-testid={testId}
    >
      <span>{children}</span>
      {arrow && <Arrow />}
    </Link>
  );
}
