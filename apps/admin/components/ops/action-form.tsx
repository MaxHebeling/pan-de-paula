"use client";
import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type FormState = { ok?: boolean; error?: string; message?: string; data?: unknown };

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/**
 * Formulario genérico sobre una server action `(prev, formData) => FormState`.
 * Muestra error/éxito, limpia el formulario al guardar y refresca los datos del servidor.
 */
export function ActionForm({
  action,
  children,
  className = "flex flex-col gap-3",
  resetOnSuccess = true,
  successMessage,
  onSuccess,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  successMessage?: string;
  onSuccess?: (state: FormState) => void;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const lastHandled = useRef<FormState | null>(null);
  useEffect(() => {
    if (state.ok && lastHandled.current !== state) {
      lastHandled.current = state;
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.(state);
      router.refresh();
    }
  }, [state, resetOnSuccess, onSuccess, router]);
  return (
    <form ref={ref} action={formAction} className={className} aria-busy={pending}>
      {children}
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      {state.ok && (state.message || successMessage) && (
        <p role="status" className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.message ?? successMessage}
        </p>
      )}
    </form>
  );
}
