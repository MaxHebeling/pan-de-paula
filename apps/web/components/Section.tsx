import Link from "next/link";

export function Section({
  eyebrow,
  title,
  intro,
  action,
  children,
  className = "",
  id,
}: {
  eyebrow?: string;
  title: string;
  intro?: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`container-x py-12 sm:py-16 ${className}`}
      aria-labelledby={id ? `${id}-title` : undefined}
    >
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
          <h2 id={id ? `${id}-title` : undefined} className="display text-3xl sm:text-4xl">
            {title}
          </h2>
          {intro && <p className="mt-3 text-base text-ink-2 sm:text-lg">{intro}</p>}
        </div>
        {action && (
          <Link href={action.href} className="btn btn-secondary">
            {action.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
