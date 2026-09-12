import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Carga el .env de la raíz del monorepo en local (Next solo lee el .env de la app). En Vercel no existe y no hace nada.
loadEnv({ path: resolve(process.cwd(), "../../.env"), override: false, quiet: true });
import { withSentryConfig } from "@sentry/nextjs/config";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  transpilePackages: ["@pdp/db", "@pdp/domain", "@pdp/auth", "@pdp/integrations"],
  serverExternalPackages: ["pg", "@node-rs/argon2"],
  // Subida de imágenes de catálogo por server action (máximo 5 MB por imagen + campos del formulario).
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

/**
 * Sentry: la subida de source maps y la instrumentación de build solo se activan con SENTRY_AUTH_TOKEN
 * (CI / Vercel). Sin token, la app usa la config plana y el SDK sigue activo en runtime si hay DSN.
 */
const config = process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      disableLogger: true,
      telemetry: false,
      sourcemaps: { deleteSourcemapsAfterUpload: true },
    })
  : nextConfig;

export default config;
