"use client";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/**
 * Formulario genérico para server actions: muestra error/éxito, deshabilita el botón mientras corre,
 * confirmación opcional y limpieza tras éxito.
 */
export function ActionForm({
  action,
  children,
  submitLabel = "Guardar",
  pendingLabel = "Guardando…",
  variant = "primary",
  size,
  confirm,
  className = "",
  resetOnOk = false,
  inline = false,
  id,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel?: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "confirm" | "danger" | "undo";
  size?: "sm" | "lg";
  confirm?: string;
  className?: string;
  resetOnOk?: boolean;
  inline?: boolean;
  id?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnOk) ref.current?.reset();
  }, [state, resetOnOk]);
  const msgs = (
    <>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.ok}
        </p>
      )}
    </>
  );
  return (
    <form
      id={id}
      ref={ref}
      action={formAction}
      className={inline ? `flex flex-wrap items-end gap-2 ${className}` : `flex flex-col gap-3 ${className}`}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {!inline && msgs}
      <button
        type="submit"
        className={`btn btn-${variant} ${size ? `btn-${size}` : ""}`}
        disabled={pending}
      >
        {pending ? pendingLabel : submitLabel}
      </button>
      {inline && msgs}
    </form>
  );
}
