import type { ErrorEvent, EventHint } from "@sentry/nextjs";

const SENSITIVE_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "x-signature",
  "x-hub-signature-256",
];

/** Elimina cookies, Authorization y firmas antes de enviar cualquier evento. */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(k.toLowerCase())) delete event.request.headers[k];
      }
    }
    if (event.request.data && typeof event.request.data === "object") {
      const d = event.request.data as Record<string, unknown>;
      for (const k of Object.keys(d)) {
        if (/(password|token|secret|card|authorization)/i.test(k)) d[k] = "[REDACTED]";
      }
    }
  }
  if (event.user) {
    delete event.user.ip_address;
    delete event.user.email;
  }
  return event;
}

/** Opciones comunes a servidor, edge y cliente. */
export function sentryBaseOptions(app: "web" | "admin") {
  return {
    environment: process.env.APP_ENV ?? process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    initialScope: { tags: { app } },
    ignoreErrors: ["NEXT_REDIRECT", "NEXT_NOT_FOUND", "AbortError"],
  };
}
