import { databaseUrl } from "../../db/scripts/env.ts";

/**
 * Base de pruebas de @pdp/integrations: `${DATABASE_URL_TEST}_int`, para no chocar con la suite de
 * @pdp/db ni con la de apps/web cuando turbo las ejecuta en paralelo.
 */
export function integrationsTestDatabaseUrl(): string {
  const u = new URL(databaseUrl("test"));
  u.pathname = `${u.pathname}_int`;
  return u.toString();
}
