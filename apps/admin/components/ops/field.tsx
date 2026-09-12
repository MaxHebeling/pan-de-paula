import type { ReactNode } from "react";

/** Etiqueta + control, con espaciado uniforme. */
export function Field({
  label,
  htmlFor,
  children,
  hint,
  className = "",
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}
