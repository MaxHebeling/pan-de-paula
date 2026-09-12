// Sentry en el navegador. Activo solo si hay NEXT_PUBLIC_SENTRY_DSN (Next 15.3+ carga este archivo antes de hidratar).
import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "./lib/sentry-options";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    ...sentryBaseOptions("admin"),
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
