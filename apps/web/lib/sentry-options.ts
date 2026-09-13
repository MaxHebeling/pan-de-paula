import type { ErrorEvent, EventHint } from "@sentry/nextjs";
import { REDACTED, redact, redactQueryString, redactString, redactUrl } from "@pdp/domain";

const SENSITIVE_HEADERS = [
  "cookie",
  "set-cookie",
  "authorization",
  "x-signature",
  "x-hub-signature-256",
  "x-vercel-protection-bypass",
];

/**
 * `beforeSend`: elimina cookies, Authorization, firmas, IP y email, y redacta tokens/secretos en URL,
 * query string, cuerpo, `extra`, `contexts`, mensajes, excepciones y breadcrumbs (regresión auditoría 360°:
 * `?access_token=…` y `extra.token` se enviaban tal cual).
 */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      for (const k of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(k.toLowerCase())) delete event.request.headers[k];
      }
    }
    if (event.request.url) event.request.url = redactUrl(event.request.url);
    if (event.request.query_string !== undefined)
      event.request.query_string = redactQueryString(event.request.query_string);
    if (event.request.data !== undefined)
      event.request.data =
        typeof event.request.data === "string"
          ? redactString(event.request.data)
          : redact(event.request.data);
  }
  if (event.extra) event.extra = redact(event.extra);
  if (event.contexts) event.contexts = redact(event.contexts);
  if (event.tags) event.tags = redact(event.tags);
  if (typeof event.message === "string") event.message = redactString(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactString(ex.value);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: b.message ? redactString(b.message) : b.message,
      data: b.data
        ? redact({
            ...b.data,
            ...(typeof b.data.url === "string" ? { url: redactUrl(b.data.url) } : {}),
          })
        : b.data,
    }));
  }
  if (event.user) {
    delete event.user.ip_address;
    delete event.user.email;
  }
  return event;
}

export { REDACTED };

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
