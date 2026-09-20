"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { PhoneField } from "@/components/PhoneField";
import {
  completePortalProfileAction,
  type PortalProfileState,
} from "@/app/portal/(sesion)/actions";

/**
 * Los clientes que se registraron antes de que el alta pidiera todos los datos (o en el mostrador,
 * con prisa) pueden completarlos ellos mismos desde su portal. Solo aparecen los campos que FALTAN:
 * lo que ya tienen no se toca aquí, se corrige con el equipo para que quede auditado en el CRM.
 */
export function CompleteProfile({
  needsPhone,
  needsBirthday,
}: {
  needsPhone: boolean;
  needsBirthday: boolean;
}) {
  const [state, action] = useActionState<PortalProfileState, FormData>(
    completePortalProfileAction,
    null,
  );
  // El aviso va ANTES de la salida temprana: al guardar, la página se revalida y ya no falta nada,
  // pero quien acaba de escribir sus datos merece ver que se guardaron.
  if (state?.ok)
    return (
      <p className="rounded-card border border-sage/40 bg-sage/10 px-4 py-3 text-sm" role="status">
        {state.ok}
      </p>
    );
  if (!needsPhone && !needsBirthday) return null;

  const faltan = [needsPhone ? "tu celular" : null, needsBirthday ? "tu fecha de nacimiento" : null]
    .filter(Boolean)
    .join(" y ");

  return (
    <form action={action} className="card space-y-4 p-5 sm:p-6" data-testid="portal-completar">
      <div>
        <h2 className="font-display text-xl text-ink">Completa tu cuenta</h2>
        <p className="mt-1 text-sm text-ink-2">
          Nos falta {faltan}. Con eso te avisamos cuando esté tu pedido y te felicitamos en tu
          cumpleaños.
        </p>
      </div>
      {needsPhone && (
        <PhoneField
          name="phone"
          label="Celular"
          required
          error={state?.field === "phone" ? state.error : null}
          testId="portal-phone"
        />
      )}
      {needsBirthday && (
        <div>
          <label htmlFor="birthday" className="label">
            Fecha de nacimiento
          </label>
          <input
            id="birthday"
            name="birthday"
            type="date"
            className="input sm:max-w-xs"
            required
            max={new Date().toISOString().slice(0, 10)}
            aria-invalid={state?.field === "birthday"}
            data-testid="portal-birthday"
          />
          {state?.field === "birthday" && (
            <p className="error" role="alert">
              {state.error}
            </p>
          )}
        </div>
      )}
      {state?.error && !state.field && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-sage" disabled={pending}>
      {pending ? "Guardando…" : "Guardar mis datos"}
    </button>
  );
}
