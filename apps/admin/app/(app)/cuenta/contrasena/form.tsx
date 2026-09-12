"use client";
import { useActionState } from "react";
import { changePasswordAction } from "./actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div>
        <label className="label" htmlFor="current">
          Contraseña actual
        </label>
        <input
          id="current"
          name="current"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="next">
          Nueva contraseña
        </label>
        <input
          id="next"
          name="next"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={10}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="confirm">
          Confirmar nueva contraseña
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          className="input"
          autoComplete="new-password"
          required
        />
      </div>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      <button className="btn btn-primary" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </button>
    </form>
  );
}
