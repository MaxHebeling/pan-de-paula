import { recreateDatabase } from "../../../packages/db/scripts/recreate.ts";
import { webTestDatabaseUrl } from "./db-url.ts";

/** Recrea la base de pruebas de apps/web (`${DATABASE_URL_TEST}_web`) y aplica migraciones. */
export default async function setup() {
  await recreateDatabase(webTestDatabaseUrl());
}
