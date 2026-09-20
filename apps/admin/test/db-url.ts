import { databaseUrl } from "../../../packages/db/scripts/env.ts";

/**
 * Base de pruebas de apps/admin: `${DATABASE_URL_TEST}_admin` para no chocar con las suites de
 * @pdp/db ni de apps/web cuando turbo las ejecuta en paralelo (mismo patrón que apps/web).
 */
export function adminTestDatabaseUrl(): string {
  const u = new URL(databaseUrl("test"));
  u.pathname = `${u.pathname}_admin`;
  return u.toString();
}
