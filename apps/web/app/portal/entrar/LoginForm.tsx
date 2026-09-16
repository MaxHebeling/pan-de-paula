"use client";

import { useActionState } from "react";
import { requestPortalLinkAction, type PortalLoginState } from "./actions";

export function PortalLoginForm() {
  const [state, action, pending] = useActionState<PortalLoginState, FormData>(
    requestPortalLinkAction,
    null,
  );

  if (state?.sent) {
    return (
      <div className="card p-6 sm:p-8" role="status" data-testid="portal-link-sent">
        <h2 className="font-display text-2xl text-ink">Revisa tu correo</h2>
        <p className="mt-3 text-ink-2">
          Si <strong className="text-ink">{state.email}</strong> tiene una tarjeta del club, te
          acabamos de enviar un enlace para entrar. Caduca en una hora y sirve una sola vez.
        </p>
        <p className="mt-3 text-sm text-ink-2">
          ¿No te llegó? Revisa la carpeta de correo no deseado o pídelo en la panadería: con gusto
          te lo generamos en el mostrador.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="card space-y-5 p-6 sm:p-8" noValidate>
      <div>
        <label htmlFor="portal-email" className="label">
          Tu correo electrónico
        </label>
        <input
          id="portal-email"
          name="email"
          type="email"
          className="input"
          autoComplete="email"
          inputMode="email"
          required
          maxLength={254}
          defaultValue={state?.email}
          aria-invalid={Boolean(state?.error)}
          data-testid="portal-email"
        />
        <p className="help">Es el mismo correo con el que te registraste en el club.</p>
      </div>
      {state?.error && (
        <p className="error" role="alert" data-testid="portal-error">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        className="btn btn-primary btn-lg w-full"
        disabled={pending}
        data-testid="portal-submit"
      >
        {pending ? "Enviando el enlace…" : "Enviarme el enlace"}
      </button>
      <p className="text-xs text-ink-2">
        No necesitas contraseña: te mandamos un enlace personal que caduca en una hora.
      </p>
    </form>
  );
}
