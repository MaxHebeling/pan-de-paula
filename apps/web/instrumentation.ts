import * as Sentry from "@sentry/nextjs";

/** Next carga este archivo una vez por runtime al arrancar el servidor. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

/** Errores de Server Components, Route Handlers y Server Actions. */
export const onRequestError = Sentry.captureRequestError;
