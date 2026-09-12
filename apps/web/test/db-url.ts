import { databaseUrl } from "../../../packages/db/scripts/env.ts";

/**
 * Base de pruebas de apps/web: `${DATABASE_URL_TEST}_web` para no chocar con la suite de @pdp/db
 * cuando turbo ejecuta ambas en paralelo.
 */
export function webTestDatabaseUrl(): string {
  const u = new URL(databaseUrl("test"));
  u.pathname = `${u.pathname}_web`;
  return u.toString();
}
