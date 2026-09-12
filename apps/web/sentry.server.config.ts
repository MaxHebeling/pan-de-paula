// Sentry (Node runtime). Activo solo si hay SENTRY_DSN. Cargado desde instrumentation.ts.
import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "./lib/sentry-options";

const dsn = process.env.SENTRY_DSN;
if (dsn) Sentry.init({ dsn, ...sentryBaseOptions("web") });
