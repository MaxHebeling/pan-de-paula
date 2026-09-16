"use client";

import { useActionState } from "react";
import { PhoneField } from "@/components/PhoneField";
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
        <PhoneField
          name="phone"
          label="Teléfono (opcional)"
          defaultCountry={v?.phone_country}
          defaultValue={v?.phone}
          error={err("phone")}
          testId="join-phone"
        />
        <div>
          <label htmlFor="email" className="label">
            Correo electrónico
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={v?.email}
            className="input"
            autoComplete="email"
            inputMode="email"
            required
            maxLength={254}
            aria-invalid={Boolean(err("email"))}
            data-testid="join-email"
          />
          {err("email") ? (
            <p className="error" role="alert">
              {err("email")}
            </p>
          ) : (
            <p className="help">Con él entras a tu cuenta y te enviamos tu tarjeta.</p>
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
          <p className="font-medium">Ese correo o teléfono ya tiene una tarjeta del club.</p>
          <p className="mt-1 text-ink-2">
            Para proteger tus datos no la mostramos aquí.{" "}
            {state.emailSent
              ? "Te enviamos el enlace de tu tarjeta al correo registrado."
              : "Pídela en la panadería o escríbenos y te la reenviamos."}{" "}
            También puedes{" "}
            <a href="/portal/entrar" className="underline">
              entrar a tu cuenta
            </a>{" "}
            con tu correo.
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
      <p className="text-sm text-ink-2">
        ¿Ya tienes tarjeta?{" "}
        <a href="/portal/entrar" className="text-sage underline">
          Entra a tu cuenta
        </a>
        .
      </p>
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
