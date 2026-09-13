"use client";

import { useActionState } from "react";
import { joinClubAction, type JoinState } from "./actions";

export function JoinForm() {
  const [state, action, pending] = useActionState<JoinState, FormData>(joinClubAction, null);
  const err = (f: string) => (state?.field === f ? state.error : null);
  // Tras un error, React reinicia el formulario: se repueblan los valores enviados.
  const v = state?.values;
  return (
    <form action={action} className="card space-y-5 p-6 sm:p-8" noValidate>
      <div>
        <label htmlFor="full_name" className="label">
          Nombre completo
        </label>
        <input
          id="full_name"
          name="full_name"
          defaultValue={v?.full_name}
          className="input"
          autoComplete="name"
          required
          maxLength={120}
          aria-invalid={Boolean(err("full_name"))}
          data-testid="join-name"
        />
        {err("full_name") && (
          <p className="error" role="alert">
            {err("full_name")}
          </p>
        )}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className="label">
            Teléfono (WhatsApp)
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={v?.phone}
            inputMode="numeric"
            className="input"
            autoComplete="tel"
            placeholder="10 dígitos"
            aria-invalid={Boolean(err("phone"))}
            data-testid="join-phone"
          />
          {err("phone") && (
            <p className="error" role="alert">
              {err("phone")}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="email" className="label">
            Correo (opcional)
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={v?.email}
            className="input"
            autoComplete="email"
            aria-invalid={Boolean(err("email"))}
          />
          {err("email") && (
            <p className="error" role="alert">
              {err("email")}
            </p>
          )}
        </div>
      </div>
      <div>
        <label htmlFor="birthday" className="label">
          Cumpleaños (opcional)
        </label>
        <input
          id="birthday"
          name="birthday"
          type="date"
          defaultValue={v?.birthday}
          className="input sm:max-w-xs"
        />
        <p className="help">Ese día tus puntos valen doble.</p>
      </div>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="marketing_consent"
          defaultChecked={v?.marketing_consent}
          className="mt-1 h-5 w-5 accent-sage"
        />
        <span className="text-sm text-ink-2">
          Quiero enterarme de temporadas, novedades y promociones por WhatsApp o correo. Puedo darme
          de baja cuando quiera.
        </span>
      </label>
      {state?.error && !state.field && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state?.notice === "existing" && (
        <div
          className="rounded-card border border-crust/50 bg-crust/10 px-4 py-3 text-sm text-ink"
          role="status"
          data-testid="join-existing"
        >
          <p className="font-medium">Ese teléfono o correo ya tiene una tarjeta del club.</p>
          <p className="mt-1 text-ink-2">
            Para proteger tus datos no la mostramos aquí.{" "}
            {state.emailSent
              ? "Te enviamos el enlace de tu tarjeta al correo registrado."
              : "Pídela en la panadería con tu teléfono o escríbenos y te la reenviamos."}
          </p>
        </div>
      )}
      <button
        type="submit"
        className="btn btn-primary btn-lg w-full sm:w-auto"
        disabled={pending}
        data-testid="join-submit"
      >
        {pending ? "Creando tu tarjeta…" : "Crear mi tarjeta"}
      </button>
      <p className="text-xs text-ink-2">
        Al registrarte aceptas el{" "}
        <a href="/privacidad" className="underline">
          aviso de privacidad
        </a>
        . Solo usamos tus datos para el club y tus pedidos.
      </p>
    </form>
  );
}
