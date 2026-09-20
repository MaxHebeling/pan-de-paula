"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  activarPush,
  enPantallaCompleta,
  esIOS,
  estadoPush,
  registrarServiceWorker,
  type PushEstado,
} from "@/lib/pwa";

/**
 * Los dos avisos de la aplicación: instalarla y activar las notificaciones.
 *
 * Reglas de cortesía, porque un permiso pedido a destiempo se deniega para siempre:
 *   · el permiso NO se pide al entrar, sino cuando el cliente ya está en "Mis pedidos" y toca
 *     "Activar avisos": primero explicamos para qué, después pregunta el navegador;
 *   · "Ahora no" se recuerda en el navegador y no se vuelve a preguntar en 30 días;
 *   · si ya está instalada, el botón de instalar desaparece;
 *   · en iPhone no hay diálogo de instalación: se explica el camino real (Compartir → Agregar a
 *     pantalla de inicio) y solo cuando tiene sentido, no a cada rato.
 */
const APLAZADO = "pdp-avisos-aplazado";
const DIAS = 30;

/** localStorage puede estar bloqueado (modo privado, cookies de terceros): nunca debe romper nada. */
function leerAplazado(): number {
  try {
    return Number(localStorage.getItem(APLAZADO) ?? 0);
  } catch {
    return 0;
  }
}
function guardarAplazado(): void {
  try {
    localStorage.setItem(APLAZADO, String(Date.now()));
  } catch {
    /* sin almacenamiento: se vuelve a ofrecer la próxima vez, y ya */
  }
}

type PromptInstalacion = Event & { prompt: () => Promise<void> };

/**
 * Lo que solo se sabe en el navegador se lee con `useSyncExternalStore`: en el servidor devuelve el
 * valor conservador (instalada / aplazado) para que el cartel NO parpadee al hidratar, y en el
 * navegador el valor real. Es el mismo patrón que el selector de país del formulario.
 */
const noopSubscribe = () => () => {};
const yaAplazado = () => Date.now() - leerAplazado() < DIAS * 86_400_000;

export function AppBanners({
  vapidPublicKey,
  pedirAvisos = false,
}: {
  vapidPublicKey: string | null;
  /** Solo las pantallas donde tiene sentido (Mis pedidos) ofrecen activar los avisos. */
  pedirAvisos?: boolean;
}) {
  const [push, setPush] = useState<PushEstado | null>(null);
  const [instalable, setInstalable] = useState<PromptInstalacion | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  // "Se acaba de instalar" y "acaba de tocar Ahora no" se suman a lo que ya sabía el navegador.
  const [instaladaAhora, setInstaladaAhora] = useState(false);
  const [aplazadaAhora, setAplazadaAhora] = useState(false);

  const enApp = useSyncExternalStore(noopSubscribe, enPantallaCompleta, () => true);
  const ios = useSyncExternalStore(noopSubscribe, esIOS, () => false);
  const aplazadoPrevio = useSyncExternalStore(noopSubscribe, yaAplazado, () => true);
  const instalada = enApp || instaladaAhora;
  const aplazado = aplazadoPrevio || aplazadaAhora;

  useEffect(() => {
    void registrarServiceWorker();
    void estadoPush().then(setPush);

    const alPoderInstalar = (e: Event) => {
      e.preventDefault(); // el navegador no decide cuándo: lo ofrecemos nosotros
      setInstalable(e as PromptInstalacion);
    };
    const alInstalar = () => {
      setInstaladaAhora(true);
      setInstalable(null);
    };
    window.addEventListener("beforeinstallprompt", alPoderInstalar);
    window.addEventListener("appinstalled", alInstalar);
    return () => {
      window.removeEventListener("beforeinstallprompt", alPoderInstalar);
      window.removeEventListener("appinstalled", alInstalar);
    };
  }, []);

  const activar = useCallback(async () => {
    if (!vapidPublicKey) return;
    setTrabajando(true);
    setPush(await activarPush(vapidPublicKey));
    setTrabajando(false);
  }, [vapidPublicKey]);

  const instalar = useCallback(async () => {
    if (!instalable) return;
    await instalable.prompt();
    setInstalable(null);
  }, [instalable]);

  const mostrarInstalar = !instalada && (instalable !== null || (ios && !aplazado));
  const mostrarAvisos =
    pedirAvisos &&
    !aplazado &&
    vapidPublicKey !== null &&
    (push === "puede" || push === "denegado");

  if (!mostrarInstalar && !mostrarAvisos) return null;

  return (
    <div className="space-y-3">
      {mostrarAvisos && (
        <section
          className="card flex flex-col gap-3 border-sage/40 bg-sage/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
          data-testid="push-oferta"
        >
          <div className="min-w-0">
            <p className="font-display text-lg text-ink">
              {push === "denegado"
                ? "Los avisos están bloqueados en este navegador"
                : "¿Quieres que te avisemos cuando cambie tu pedido?"}
            </p>
            <p className="mt-1 text-sm text-ink-2">
              {push === "denegado"
                ? "Para recibirlos, permite las notificaciones de este sitio en los ajustes de tu navegador."
                : "Te mandamos un aviso al teléfono cuando entre al horno y cuando esté listo. Nada de publicidad."}
            </p>
          </div>
          {/* El aviso de "bloqueado" también se puede descartar: un cartel que no se va es una
              molestia, y quien bloqueó las notificaciones ya tomó su decisión. */}
          <div className="flex shrink-0 gap-2">
            {push !== "denegado" && (
              <button
                type="button"
                className="btn btn-sage"
                onClick={() => void activar()}
                disabled={trabajando}
                data-testid="push-activar"
              >
                {trabajando ? "Un momento…" : "Activar avisos"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                guardarAplazado();
                setAplazadaAhora(true);
              }}
              data-testid="push-ahora-no"
            >
              {push === "denegado" ? "Entendido" : "Ahora no"}
            </button>
          </div>
        </section>
      )}

      {mostrarInstalar && (
        <section
          className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
          data-testid="instalar-app"
        >
          <div className="min-w-0">
            <p className="font-display text-lg text-ink">📱 Instala Pan de Paula</p>
            <p className="mt-1 text-sm text-ink-2">
              {ios && !instalable
                ? "Toca Compartir y luego “Agregar a pantalla de inicio”. Así también podrás recibir avisos."
                : "Tus pedidos, tus puntos y tu tarjeta a un toque, como una aplicación."}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {instalable && (
              <button
                type="button"
                className="btn btn-sage"
                onClick={() => void instalar()}
                data-testid="instalar-boton"
              >
                Instalar
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                guardarAplazado();
                setAplazadaAhora(true);
                setInstalable(null);
              }}
            >
              Ahora no
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
