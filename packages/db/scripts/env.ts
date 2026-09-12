import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Carga .env de la raíz del monorepo si existe (nunca falla si no está).
const root = resolve(import.meta.dirname, "../../..");
for (const f of [".env.local", ".env"]) {
  const p = resolve(root, f);
  if (existsSync(p)) config({ path: p, override: false, quiet: true });
}

export function databaseUrl(kind: "app" | "test" = "app"): string {
  const url = kind === "test" ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      kind === "test"
        ? "Falta DATABASE_URL_TEST (ej. postgres://localhost:5432/pan_de_paula_test)"
        : "Falta DATABASE_URL (ej. postgres://localhost:5432/pan_de_paula)",
    );
  }
  return url;
}

export function sslConfig(): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL ?? "disable").toLowerCase();
  if (mode === "disable" || mode === "false" || mode === "") return false;
  // Supabase usa certificados válidos; "no-verify" solo para túneles/proxies locales.
  return { rejectUnauthorized: mode !== "no-verify" };
}
