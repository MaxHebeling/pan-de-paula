import { recreateDatabase } from "../../../packages/db/scripts/recreate.ts";
import { adminTestDatabaseUrl } from "./db-url.ts";

/** Recrea la base de pruebas de apps/admin (`${DATABASE_URL_TEST}_admin`) y aplica migraciones. */
export default async function setup() {
  await recreateDatabase(adminTestDatabaseUrl());
}
