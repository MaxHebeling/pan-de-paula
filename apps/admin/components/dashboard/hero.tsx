"use client";

import { useEffect, useState } from "react";
import { CloudMoon, Sun, Sunrise, Sunset } from "lucide-react";
import { franjaDe, lugarDeZonaHoraria, lugarLegible, saludoPara, type Franja } from "@pdp/domain";

/**
 * Encabezado del dashboard: quién está conectado, qué hora es donde está y qué momento del día es.
 *
 * El nombre y el rol llegan de la SESIÓN (los pasa el servidor); aquí no hay ningún nombre escrito a
 * mano, así que funciona igual para quien entre mañana.
 *
 * La hora, la fecha y el lugar solo se pueden saber en el navegador —son del dispositivo de quien
 * mira, no del servidor—, así que el primer render deja ese hueco vacío y se llena al montar. Sin
 * esto, el HTML del servidor y el del navegador dirían horas distintas y React avisaría del desajuste.
 */
const ICONOS: Record<Franja, typeof Sun> = {
  manana: Sunrise,
  mediodia: Sun,
  tarde: Sunset,
  noche: CloudMoon,
};

/** Color del momento del día, dentro del sistema visual del CRM (nada estridente). */
const TONOS: Record<Franja, string> = {
  manana: "text-amber-500",
  mediodia: "text-amber-400",
  tarde: "text-orange-500",
  noche: "text-indigo-400",
};

type Ahora = { hora: string; fecha: string; franja: Franja; lugar: string | null };

function leerAhora(): Ahora {
  const d = new Date();
  const zona = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    hora: new Intl.DateTimeFormat("es-MX", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(d),
    fecha: new Intl.DateTimeFormat("es-MX", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d),
    franja: franjaDe(d.getHours()),
    lugar: lugarLegible(lugarDeZonaHoraria(zona)),
  };
}

export function DashboardHero({ nombre, rol }: { nombre: string; rol: string }) {
  const [ahora, setAhora] = useState<Ahora | null>(null);

  useEffect(() => {
    // Cada segundo: el reloj se mueve solo, sin recargar y sin pedir nada al servidor.
    const tick = () => setAhora(leerAhora());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const franja: Franja = ahora?.franja ?? "manana";
  const Icono = ICONOS[franja];
  // Antes de montar, un saludo neutro: es lo único honesto sin saber la hora del dispositivo.
  const saludo = ahora
    ? saludoPara(nombre, new Date().getHours())
    : `Hola, ${nombre.trim().split(/\s+/)[0] ?? nombre}`;

  return (
    <section
      className="card mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-5"
      data-testid="dashboard-hero"
    >
      <div className="flex min-w-0 items-center gap-4">
        <span
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-full bg-teal-50 ${TONOS[franja]}`}
          data-testid="hero-icono"
          data-franja={ahora ? franja : ""}
          aria-hidden
        >
          <Icono size={26} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight" data-testid="hero-saludo">
            {saludo}
          </h1>
          <p className="mt-0.5 text-sm text-muted" data-testid="hero-rol">
            {rol}
          </p>
        </div>
      </div>

      <div className="min-w-0 sm:text-right">
        <p
          className="text-2xl font-semibold tracking-tight tabular-nums"
          data-testid="hero-hora"
          aria-live="off"
        >
          {ahora?.hora ?? "—"}
        </p>
        <p className="mt-0.5 text-sm text-muted first-letter:uppercase" data-testid="hero-fecha">
          {ahora?.fecha ?? ""}
        </p>
        <p className="mt-0.5 text-sm text-muted" data-testid="hero-lugar">
          {ahora ? (ahora.lugar ? `📍 ${ahora.lugar}` : "Ubicación no disponible") : ""}
        </p>
      </div>
    </section>
  );
}
