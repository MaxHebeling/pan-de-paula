"use client";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/** Botón de envío que se deshabilita mientras la server action está pendiente. */
export function PendingButton({
  children,
  pendingLabel = "Guardando…",
  className = "btn btn-primary",
  confirm,
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  confirm?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className={className}
      disabled={pending || disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
