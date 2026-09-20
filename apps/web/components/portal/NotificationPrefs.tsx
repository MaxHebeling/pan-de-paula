"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { guardarPreferenciasAction } from "@/app/portal/(sesion)/actions";
import { activarPush, desactivarPush, estadoPush, type PushEstado } from "@/lib/pwa";

/**
 * Qué avisos quiere el cliente, en dos planos que no se mezclan:
 *   · la CUENTA: qué tipos de aviso acepta (pedidos / promociones). Vale en todos sus dispositivos.
 *   · este DISPOSITIVO: si este teléfono en concreto recibe notificaciones. Apagarlo aquí no borra
 *     sus otros dispositivos ni cambia lo que aceptó.
 *
 * Los avisos del pedido y las promociones van separados a propósito: activar los primeros no es
 * consentimiento para publicidad.
 */
export function NotificationPrefs({
  inicial,
  vapidPublicKey,
}: {
  inicial: { orderUpdates: boolean; promotions: boolean };
  vapidPublicKey: string | null;
}) {
  const [state, action] = useActionState(guardarPreferenciasAction, null);
  const [push, setPush] = useState<PushEstado | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  useEffect(() => {
    void estadoPush().then(setPush);
  }, []);

  return (
    <div className="space-y-4">
      <form action={action} className="card space-y-4 p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">En mi cuenta</h2>
        <Check
          name="order_updates"
          defaultChecked={inicial.orderUpdates}
          label="Avisos de mis pedidos"
          help="Cuando lo confirmamos, cuando entra al horno y cuando está listo."
          testId="pref-pedidos"
        />
        <Check
          name="promotions"
          defaultChecked={inicial.promotions}
          label="Novedades y promociones"
          help="Temporadas y ofertas. Solo si además aceptaste recibir comunicaciones."
          testId="pref-promos"
        />
        <Guardar />
        {state?.ok && (
          <p className="text-sm text-sage" role="status">
            {state.ok}
          </p>
        )}
      </form>

      <section className="card space-y-3 p-5 sm:p-6">
        <h2 className="font-display text-xl text-ink">En este dispositivo</h2>
        <p className="text-sm text-ink-2" data-testid="pref-dispositivo-estado">
          {push === "listo"
            ? "Este dispositivo recibe notificaciones."
            : push === "denegado"
              ? "Las notificaciones están bloqueadas en este navegador. Permítelas en sus ajustes para volver a activarlas."
              : push === "requiere-instalar"
                ? "En iPhone las notificaciones llegan solo si agregas la aplicación a tu pantalla de inicio (Compartir → Agregar a pantalla de inicio)."
                : push === "no-soportado"
                  ? "Este navegador no puede recibir notificaciones."
                  : "Este dispositivo no está recibiendo notificaciones."}
        </p>
        {push === "listo" ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={trabajando}
            data-testid="pref-apagar-dispositivo"
            onClick={() => {
              setTrabajando(true);
              void desactivarPush()
                .then(estadoPush)
                .then(setPush)
                .finally(() => setTrabajando(false));
            }}
          >
            {trabajando ? "Un momento…" : "Apagar en este dispositivo"}
          </button>
        ) : push === "puede" && vapidPublicKey ? (
          <button
            type="button"
            className="btn btn-sage"
            disabled={trabajando}
            data-testid="pref-encender-dispositivo"
            onClick={() => {
              setTrabajando(true);
              void activarPush(vapidPublicKey)
                .then(setPush)
                .finally(() => setTrabajando(false));
            }}
          >
            {trabajando ? "Un momento…" : "Activar en este dispositivo"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-sage" disabled={pending}>
      {pending ? "Guardando…" : "Guardar"}
    </button>
  );
}

function Check({
  name,
  defaultChecked,
  label,
  help,
  testId,
}: {
  name: string;
  defaultChecked: boolean;
  label: string;
  help: string;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-1 h-5 w-5 accent-sage"
        data-testid={testId}
      />
      <span>
        <span className="block text-ink">{label}</span>
        <span className="block text-sm text-ink-2">{help}</span>
      </span>
    </label>
  );
}
