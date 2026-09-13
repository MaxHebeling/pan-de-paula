// Sentry en el navegador. Activo solo si hay NEXT_PUBLIC_SENTRY_DSN (Next 15.3+ carga este archivo antes de hidratar).
//
// El SDK (~135 KB gz) se carga con import dinámico cuando el hilo principal queda libre, fuera de la ruta crítica
// del LCP. Mientras llega, los errores y rechazos no manejados se guardan y se reenvían al iniciar, así no se
// pierde nada de la ventana inicial (solo pierden breadcrumbs previos al init).
import type * as SentryTypes from "@sentry/nextjs";
import { sentryBaseOptions } from "./lib/sentry-options";

type SentryModule = typeof SentryTypes;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let sentry: SentryModule | null = null;
const early: unknown[] = [];

function onEarlyError(e: ErrorEvent) {
  early.push(e.error ?? e.message);
}
function onEarlyRejection(e: PromiseRejectionEvent) {
  early.push(e.reason);
}

async function loadSentry() {
  try {
    const mod = await import("@sentry/nextjs");
    mod.init({
      dsn,
      ...sentryBaseOptions("web"),
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
    sentry = mod;
    window.removeEventListener("error", onEarlyError);
    window.removeEventListener("unhandledrejection", onEarlyRejection);
    for (const err of early.splice(0)) mod.captureException(err);
  } catch (e) {
    console.error("[sentry] no se pudo inicializar el SDK del navegador", e);
  }
}

if (dsn && typeof window !== "undefined") {
  window.addEventListener("error", onEarlyError);
  window.addEventListener("unhandledrejection", onEarlyRejection);
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(() => void loadSentry(), { timeout: 4000 });
  else window.setTimeout(() => void loadSentry(), 1500);
}

export const onRouterTransitionStart: SentryModule["captureRouterTransitionStart"] = (
  href,
  navigationType,
) => {
  sentry?.captureRouterTransitionStart(href, navigationType);
};
