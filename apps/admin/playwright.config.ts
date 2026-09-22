import { defineConfig, devices } from "@playwright/test";
// Carga .env.local/.env igual que el resto del repo. Sin esto, las pruebas que hablan con la base
// (leen `process.env.DATABASE_URL` directo, no por `databaseUrl()`) solo corrían en CI, donde la
// variable viene del workflow: en local fallaban con "Falta DATABASE_URL" antes de abrir el navegador.
import "../../packages/db/scripts/env.ts";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  // E2E_NO_SERVER=1: correr contra un ambiente ya desplegado (smoke post-deploy) sin levantar `pnpm start`.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm start",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
