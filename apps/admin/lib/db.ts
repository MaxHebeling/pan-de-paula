import "server-only";
import { getDb } from "@pdp/db";
export { sql, callFn, withStaff, dbErrorMessage } from "@pdp/db";
export const db = () => getDb();
