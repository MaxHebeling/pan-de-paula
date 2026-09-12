"use client";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { idle, type ActionState } from "@/lib/action-state";
import { OneTimeSecret } from "./one-time-secret";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * Formulario ligado a una server action con estado (error / ok / data).
 * `resetOnSuccess` limpia los campos al terminar bien (útil en formularios de "agregar").
 * `secret` muestra un dato de una sola vez devuelto en `state.data[valueKey]` (contraseña temporal, enlace).
 */
export function ActionForm({
  action,
  children,
  className = "",
  resetOnSuccess = false,
  secret,
  confirm: confirmMessage,
  id,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  secret?: { label: string; valueKey: string; hint?: string };
  confirm?: string;
  id?: string;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, idle);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      id={id}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {children}
      <FormMessage state={state} />
      {state.data && secret && state.data[secret.valueKey] ? (
        <OneTimeSecret label={secret.label} value={state.data[secret.valueKey]!} hint={secret.hint} />
      ) : null}
    </form>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.error)
    return (
      <p role="alert" className="st-red mt-3 rounded-[var(--r-btn)] px-3 py-2 text-sm">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="st-green mt-3 rounded-[var(--r-btn)] px-3 py-2 text-sm">
        {state.ok}
      </p>
    );
  return null;
}

export function SubmitButton({
  children,
  pendingText = "Guardando…",
  variant = "primary",
  size,
  className = "",
  disabled,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "confirm" | "danger";
  size?: "sm" | "lg";
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ""} ${className}`}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? pendingText : children}
    </button>
  );
}

/**
 * Botón de acción directa (sin estado) con confirmación opcional. Úsalo dentro de `<form action={bound}>`.
 */
export function ConfirmButton({
  children,
  confirm: confirmMessage,
  variant = "secondary",
  size = "sm",
  className = "",
  title,
  name,
  value,
}: {
  children: ReactNode;
  confirm?: string;
  variant?: "primary" | "secondary" | "confirm" | "danger";
  size?: "sm" | "lg";
  className?: string;
  title?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
