import { recreateDatabase } from "../../db/scripts/recreate.ts";
import { integrationsTestDatabaseUrl } from "./db-url.ts";

/** Recrea la base de pruebas de @pdp/integrations y aplica migraciones (la usa push.test.ts). */
export default async function setup() {
  await recreateDatabase(integrationsTestDatabaseUrl());
}
