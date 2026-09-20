"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Mantiene la pantalla al día sin que nadie recargue.
 *
 * Sondea `/api/portal/pulso` mientras la pestaña está VISIBLE y, cuando algo cambió respecto a lo
 * que se está mostrando, pide a Next que vuelva a renderizar la página en el servidor
 * (`router.refresh()`): así los datos siguen saliendo de las mismas consultas de siempre, con el
 * mismo filtro por sesión, y no hay una segunda copia del estado en el navegador.
 *
 * Buen ciudadano: un solo intervalo, se detiene al ocultar la pestaña y se limpia al desmontar (no
 * quedan escuchas vivas al cerrar sesión). Si la red falla, no insiste más rápido ni rompe la
 * pantalla: simplemente lo intenta en el siguiente turno.
 */
const INTERVALO_MS = 10_000;

export type Pulso = {
  unread: number;
  orders: Array<{ folio: string; status: string; updatedAt: string }>;
};

/** Huella de lo que se está mostrando: si cambia, hay novedad. */
export function huella(p: Pulso): string {
  return `${p.unread}|${p.orders.map((o) => `${o.folio}:${o.status}:${o.updatedAt}`).join(",")}`;
}

export function LiveOrders({ inicial }: { inicial: Pulso }) {
  const router = useRouter();
  const actual = useRef(huella(inicial));
  const [offline, setOffline] = useState(false);

  // La huella del servidor manda: tras un refresh, esta es la nueva referencia.
  useEffect(() => {
    actual.current = huella(inicial);
  }, [inicial]);

  useEffect(() => {
    let cancelado = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function mirar() {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/portal/pulso", { cache: "no-store" });
        if (!r.ok) return; // 401 → la sesión terminó; la propia navegación se encarga.
        const p = (await r.json()) as Pulso;
        if (cancelado) return;
        setOffline(false);
        if (huella(p) !== actual.current) {
          actual.current = huella(p);
          router.refresh();
        }
      } catch {
        // Sin conexión: no se inventa nada, se avisa y se reintenta en el siguiente turno.
        if (!cancelado) setOffline(true);
      }
    }

    const arrancar = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => void mirar(), INTERVALO_MS);
      void mirar();
    };
    const visibilidad = () => {
      if (document.visibilityState === "visible") arrancar();
      else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    arrancar();
    document.addEventListener("visibilitychange", visibilidad);
    window.addEventListener("online", arrancar);
    return () => {
      cancelado = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilidad);
      window.removeEventListener("online", arrancar);
    };
  }, [router]);

  if (!offline) return null;
  return (
    <p
      className="rounded-card border border-line bg-cream-2 px-4 py-3 text-sm text-ink-2"
      role="status"
      data-testid="portal-offline"
    >
      Sin conexión. El estado se actualizará cuando recuperes internet.
    </p>
  );
}
