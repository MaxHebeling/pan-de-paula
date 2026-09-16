import type { ReactNode } from "react";
import Link from "next/link";
import { money } from "@/lib/format";

type Tone = "green" | "amber" | "red" | "blue" | "gray";

export function Badge({
  tone = "gray",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`st-${tone} pill inline-flex items-center px-2.5 py-0.5 text-xs font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  title,
  action,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={`card p-4 md:p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className={`mt-1 text-xs ${tone ? `text-${tone}-d` : "text-muted"}`}>{hint}</div>
      )}
    </div>
  );
}

export function Money({
  cents,
  compact,
  className = "",
}: {
  cents: number | string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  return <span className={`tabular-nums ${className}`}>{money(cents, { compact })}</span>;
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="font-semibold">{title}</p>
      {body && <p className="mt-1 max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LinkButton({
  href,
  children,
  variant = "primary",
  size,
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "confirm" | "danger";
  size?: "sm" | "lg";
  className?: string;
}) {
  return (
    <Link href={href} className={`btn btn-${variant} ${size ? `btn-${size}` : ""} ${className}`}>
      {children}
    </Link>
  );
}

export function Alert({
  tone = "blue",
  role,
  children,
}: {
  tone?: Tone;
  /** "alert" para errores, "status" para confirmaciones; igual que FormMessage. */
  role?: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <div role={role} className={`st-${tone} rounded-[var(--r-card)] px-4 py-3 text-sm`}>
      {children}
    </div>
  );
}

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`card overflow-x-auto ${className}`}>
      <table className="w-full text-sm [&_td]:px-3 [&_td]:py-2.5 [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line">
        {children}
      </table>
    </div>
  );
}
