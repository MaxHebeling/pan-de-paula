#!/usr/bin/env node
/**
 * Valida que las variables requeridas existan y sean coherentes para el entorno indicado.
 * Uso: node scripts/check-env.mjs [production|staging|development]
 *
 * Reglas:
 *  - Base (todos los entornos): DATABASE_URL, SESSION_SECRET (32+), NEXT_PUBLIC_*, CRON_SECRET (16+; los crons
 *    rechazan secretos más cortos en `isCronAuthorized`).
 *  - Producción/staging: DATABASE_SSL=require, DATABASE_URL no local, sin valores CAMBIAME.
 *  - Integraciones: opcionales, pero si una está "a medias" es un error (p. ej. token de Mercado Pago sin
 *    MERCADOPAGO_WEBHOOK_SECRET → producción rechaza todas las notificaciones con 500 y ningún pago se concilia).
 *  - El `.env` local solo se usa como respaldo en development: para staging/producción se valida
 *    exclusivamente lo que ya está en el entorno (deploy.sh carga `.env.<env>` antes de llamar aquí).
 */
import { readFileSync, existsSync } from "node:fs";

const env = process.argv[2] ?? process.env.APP_ENV ?? "development";
const remote = env === "production" || env === "staging";

if (!remote && existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const get = (k) => process.env[k] ?? "";
const set = (k) => get(k) !== "";
const base = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_ADMIN_URL",
  "CRON_SECRET",
];
const prodOptional = [
  "MERCADOPAGO_ACCESS_TOKEN",
  "MERCADOPAGO_WEBHOOK_SECRET",
  "SENTRY_DSN",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];

const errors = [];
const warnings = [];

const missing = base.filter((k) => !set(k) || /CAMBIAME/.test(get(k)));
if (missing.length) errors.push(`Faltan variables: ${missing.join(", ")}`);

if (get("SESSION_SECRET").length < 32) errors.push("SESSION_SECRET debe tener 32+ caracteres");
if (set("CRON_SECRET") && get("CRON_SECRET").length < 16)
  errors.push(
    `CRON_SECRET debe tener 16+ caracteres (tiene ${get("CRON_SECRET").length}); con menos, /api/cron/* responde 401 siempre`,
  );

if (remote) {
  if ((get("DATABASE_SSL") || "disable") === "disable")
    errors.push(`DATABASE_SSL debe ser 'require' en ${env}`);
  if (/localhost|127\.0\.0\.1/.test(get("DATABASE_URL")))
    errors.push(`DATABASE_URL apunta a localhost en ${env}`);
  if (get("DATABASE_SSL") === "require" && !set("DATABASE_CA_CERT"))
    warnings.push("sin DATABASE_CA_CERT la verificación TLS depende de las CA del sistema");
  for (const k of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_ADMIN_URL"])
    if (set(k) && !/^https:\/\//.test(get(k))) errors.push(`${k} debe ser https:// en ${env}`);
}

// Integraciones a medias (error en cualquier entorno: el código las trata como configuradas y falla en runtime)
const pairs = [
  [
    "MERCADOPAGO_ACCESS_TOKEN",
    ["MERCADOPAGO_WEBHOOK_SECRET"],
    "sin secreto el webhook responde 500 y ningún pago se concilia",
  ],
  [
    "MERCADOPAGO_WEBHOOK_SECRET",
    ["MERCADOPAGO_ACCESS_TOKEN"],
    "las notificaciones no se pueden consultar (GET /v1/payments) y quedan failed",
  ],
  [
    "INSTAGRAM_PAGE_ACCESS_TOKEN",
    ["META_APP_SECRET", "META_VERIFY_TOKEN"],
    "el webhook de Instagram no puede verificarse ni firmarse",
  ],
  [
    "RESEND_API_KEY",
    ["EMAIL_FROM"],
    "sendEmail se considera no configurado y omite todos los correos",
  ],
];
for (const [ifSet, needs, why] of pairs) {
  if (!set(ifSet)) continue;
  const lack = needs.filter((k) => !set(k));
  if (lack.length) errors.push(`${ifSet} está definido pero falta ${lack.join(", ")}: ${why}`);
}
if (get("STORAGE_DRIVER") === "supabase") {
  const lack = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !set(k));
  if (lack.length) errors.push(`STORAGE_DRIVER=supabase requiere ${lack.join(", ")}`);
} else if (set("STORAGE_DRIVER") && get("STORAGE_DRIVER") !== "local") {
  errors.push(`STORAGE_DRIVER inválido: "${get("STORAGE_DRIVER")}" (local | supabase)`);
}

if (env === "production") {
  for (const k of prodOptional.filter((k) => !set(k)))
    warnings.push(`falta ${k} (integración opcional; su feature flag debe seguir apagado)`);
}

for (const w of warnings) console.warn(`[${env}] Aviso: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[${env}] ✗ ${e}`);
  process.exit(1);
}
console.log(`[${env}] Variables de entorno OK`);
