"use client";

import { useState } from "react";
import { desactivarPush } from "@/lib/pwa";

/**
 * Cerrar sesión. Antes de salir apaga las notificaciones de ESTE dispositivo: si no, el teléfono
 * seguiría recibiendo los avisos de la cuenta que acaba de cerrar (importa en un teléfono prestado).
 * Si algo falla al desuscribir, la sesión se cierra igual: nunca se deja a alguien dentro.
 */
export function LogoutButton({ action }: { action: () => Promise<void> }) {
  const [saliendo, setSaliendo] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary"
      data-testid="portal-logout"
      disabled={saliendo}
      onClick={() => {
        setSaliendo(true);
        void desactivarPush()
          .catch(() => {})
          .then(() => action());
      }}
    >
      {saliendo ? "Saliendo…" : "Cerrar sesión"}
    </button>
  );
}
