#!/usr/bin/env node
/** Valida que las variables requeridas existan para el entorno indicado. Uso: node scripts/check-env.mjs [production|staging|development] */
import { readFileSync, existsSync } from "node:fs";

const env = process.argv[2] ?? process.env.APP_ENV ?? "development";
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const base = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_ADMIN_URL",
  "CRON_SECRET",
];
const prod = [
  "MERCADOPAGO_ACCESS_TOKEN",
  "MERCADOPAGO_WEBHOOK_SECRET",
  "SENTRY_DSN",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];
// Integraciones (prod): opcionales y protegidas por feature flags; avisan pero no bloquean el deploy.
const required = base;
const missing = required.filter((k) => !process.env[k] || /CAMBIAME/.test(process.env[k]));
const weak = [];
if (env === "production") {
  for (const k of prod.filter((k) => !process.env[k]))
    console.warn(
      `[${env}] Aviso: falta ${k} (integración opcional; su feature flag debe seguir apagado)`,
    );
  if (process.env.DATABASE_SSL === "require" && !process.env.DATABASE_CA_CERT)
    console.warn(
      `[${env}] Aviso: sin DATABASE_CA_CERT la verificación TLS depende de las CA del sistema`,
    );
}
if ((process.env.SESSION_SECRET ?? "").length < 32)
  weak.push("SESSION_SECRET debe tener 32+ caracteres");
if (env === "production" && (process.env.DATABASE_SSL ?? "disable") === "disable")
  weak.push("DATABASE_SSL debe ser 'require' en producción");
if (env === "production" && /localhost/.test(process.env.DATABASE_URL ?? ""))
  weak.push("DATABASE_URL apunta a localhost en producción");
if (missing.length || weak.length) {
  if (missing.length) console.error(`[${env}] Faltan variables: ${missing.join(", ")}`);
  for (const w of weak) console.error(`[${env}] ${w}`);
  process.exit(1);
}
console.log(`[${env}] Variables de entorno OK`);
