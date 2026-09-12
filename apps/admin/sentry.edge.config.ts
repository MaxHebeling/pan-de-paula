// Sentry (Edge runtime: proxy/middleware). Activo solo si hay SENTRY_DSN.
import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "./lib/sentry-options";

const dsn = process.env.SENTRY_DSN;
if (dsn) Sentry.init({ dsn, ...sentryBaseOptions("admin") });
