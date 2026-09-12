import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  onHand,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let product: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  product = await createProduct(db, "Galleta negativa", 3500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("conteo físico con stock negativo (regresión)", () => {
  it("una venta sin producción deja stock negativo y el conteo lo corrige a la cantidad contada", async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: product, qty: 1 }],
          payments: [{ provider: "cash", method: "cash", amount_cents: 3500 }],
        }),
      ]),
    );
    expect(await onHand(db, product)).toBe(-1);
    const sc = await sql<{
      id: string;
    }>`insert into stock_counts(staff_id) values (${staff}) returning id`.execute(db);
    // Se cuenta 0 (no puede haber -1 piezas en el mostrador): la corrección debe ser +1
    await sql`insert into stock_count_items(stock_count_id, product_id, expected_qty, counted_qty) values (${sc.rows[0]!.id}, ${product}, -1, 0)`.execute(
      db,
    );
    const n = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [sc.rows[0]!.id]),
    );
    expect(n).toBe(1);
    expect(await onHand(db, product)).toBe(0);
    const m = await sql<{
      qty: string;
    }>`select qty from inventory_movements where type = 'CORRECTION' and product_id = ${product}`.execute(
      db,
    );
    expect(Number(m.rows[0]!.qty)).toBe(1);
  });
});
