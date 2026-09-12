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
  product = await createProduct(db, "Rol de canela", 5500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("producción, mermas, conteos", () => {
  it("record_production incrementa stock y crea lote con evento", async () => {
    const batch = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "record_production", [product, 24, "Horneada de la mañana", null]),
    );
    expect(batch).toBeTruthy();
    expect(await onHand(db, product)).toBe(24);
    const b = await sql<{
      lot_code: string;
      qty: string;
    }>`select lot_code, qty from production_batches where id = ${batch}`.execute(db);
    expect(b.rows[0]!.lot_code).toMatch(/^L\d{6}-/);
    expect(Number(b.rows[0]!.qty)).toBe(24);
  });

  it("record_production rechaza cantidades inválidas", async () => {
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 0, null, null])),
    ).rejects.toThrow(/inválida/);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, -5, null, null])),
    ).rejects.toThrow(/inválida/);
  });

  it("merma descuenta stock y guarda motivo", async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [product, 10, null, null]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_waste", [product, 3, "burnt", "se quemaron", null]),
    );
    expect(await onHand(db, product)).toBe(7);
    const m = await sql<{
      type: string;
      reason: string;
    }>`select type, reason from inventory_movements where type = 'WASTE'`.execute(db);
    expect(m.rows[0]).toMatchObject({ type: "WASTE", reason: "burnt" });
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_waste", [product, 1, "invalid_reason", null, null]),
      ),
    ).rejects.toThrow();
  });

  it("los movimientos de inventario son inmutables", async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [product, 10, null, null]),
    );
    await expect(sql`update inventory_movements set qty = 999`.execute(db)).rejects.toThrow(
      /solo inserción/,
    );
    await expect(sql`delete from inventory_movements`.execute(db)).rejects.toThrow(
      /solo inserción/,
    );
  });

  it("conteo físico aplica correcciones y concilia", async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [product, 10, null, null]),
    );
    const sc = await sql<{
      id: string;
    }>`insert into stock_counts(staff_id) values (${staff}) returning id`.execute(db);
    await sql`insert into stock_count_items(stock_count_id, product_id, expected_qty, counted_qty) values (${sc.rows[0]!.id}, ${product}, 10, 8)`.execute(
      db,
    );
    const n = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [sc.rows[0]!.id]),
    );
    expect(n).toBe(1);
    expect(await onHand(db, product)).toBe(8);
    const again = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [sc.rows[0]!.id]),
    );
    expect(again).toBe(0);
    const rec = await sql<{
      opening: string;
      production: string;
      corrections: string;
      closing: string;
    }>`select * from inventory_reconciliation(now() - interval '1 hour', now() + interval '1 hour') where product_id = ${product}`.execute(
      db,
    );
    expect(Number(rec.rows[0]!.production)).toBe(10);
    expect(Number(rec.rows[0]!.corrections)).toBe(-2);
    expect(Number(rec.rows[0]!.closing)).toBe(8);
  });

  it("rebuild_inventory_levels reconstruye desde movimientos", async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [product, 10, null, null]),
    );
    await sql`update inventory_levels set on_hand = 999`.execute(db);
    await sql`select rebuild_inventory_levels()`.execute(db);
    expect(await onHand(db, product)).toBe(10);
  });

  it("producción descuenta ingredientes según receta cuando el flag está activo", async () => {
    const ing = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit, stock_qty) values ('Harina', 'g', 10000) returning id`.execute(
      db,
    );
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${ing.rows[0]!.id}, 1000, 2500)`.execute(
      db,
    );
    const rec = await sql<{
      id: string;
    }>`insert into recipes(product_id, yield_qty) values (${product}, 12) returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${ing.rows[0]!.id}, 600)`.execute(
      db,
    );
    await sql`update feature_flags set enabled = true where key = 'ingredient_consumption'`.execute(
      db,
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [product, 24, null, null]),
    );
    const stock = await sql<{
      stock_qty: string;
    }>`select stock_qty from ingredients where id = ${ing.rows[0]!.id}`.execute(db);
    expect(Number(stock.rows[0]!.stock_qty)).toBe(8800); // 600g por 12 piezas → 1200g por 24
  });
});

describe("costeo", () => {
  it("costo por pieza se recalcula al cambiar precio de insumo y respeta historial", async () => {
    const mant = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit) values ('Mantequilla', 'g') returning id`.execute(
      db,
    );
    const harina = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit) values ('Harina', 'g') returning id`.execute(db);
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents, valid_from) values (${mant.rows[0]!.id}, 1808, 40000, now() - interval '10 days')`.execute(
      db,
    );
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents, valid_from) values (${harina.rows[0]!.id}, 1000, 2000, now() - interval '10 days')`.execute(
      db,
    );
    const rec = await sql<{
      id: string;
    }>`insert into recipes(product_id, yield_qty) values (${product}, 10) returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${mant.rows[0]!.id}, 500)`.execute(
      db,
    );
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${harina.rows[0]!.id}, 1000)`.execute(
      db,
    );
    // mantequilla: 400/1808 = 0.221239 por g × 500 = 110.62 ; harina: 20 → total 130.62 / 10 = 13.06 → 1306 centavos
    const c1 = await sql<{ c: number }>`select product_cost_cents(${product}) as c`.execute(db);
    expect(c1.rows[0]!.c).toBe(1306);
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${mant.rows[0]!.id}, 1808, 45000)`.execute(
      db,
    );
    const c2 = await sql<{ c: number }>`select product_cost_cents(${product}) as c`.execute(db);
    expect(c2.rows[0]!.c).toBe(1444); // 450/1808*500 = 124.45 + 20 = 144.45 / 10 = 14.44
    const past = await sql<{
      c: number;
    }>`select product_cost_cents(${product}, now() - interval '1 day') as c`.execute(db);
    expect(past.rows[0]!.c).toBe(1306);
    const view = await sql<{
      margin_bps: number;
      has_missing_prices: boolean;
    }>`select margin_bps, has_missing_prices from recipe_costing where product_id = ${product}`.execute(
      db,
    );
    expect(view.rows[0]!.has_missing_prices).toBe(false);
    expect(view.rows[0]!.margin_bps).toBe(Math.round(((5500 - 1444) / 5500) * 10000));
  });

  it("la venta guarda el costo vigente aunque el insumo suba después", async () => {
    const ing = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit) values ('Azúcar', 'g') returning id`.execute(db);
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${ing.rows[0]!.id}, 1000, 3000)`.execute(
      db,
    );
    const rec = await sql<{
      id: string;
    }>`insert into recipes(product_id, yield_qty) values (${product}, 1) returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${ing.rows[0]!.id}, 100)`.execute(
      db,
    );
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 5, null, null]));
    const res = await withStaff(db, staff, (trx) =>
      callFn<{ sale_id: string; order_id: string }>(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: product, qty: 1 }],
          payments: [{ provider: "cash", method: "cash", amount_cents: 5500 }],
        }),
      ]),
    );
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${ing.rows[0]!.id}, 1000, 9000)`.execute(
      db,
    );
    const oi = await sql<{
      unit_cost_cents: number;
    }>`select unit_cost_cents from order_items where order_id = ${res.order_id}`.execute(db);
    expect(oi.rows[0]!.unit_cost_cents).toBe(300);
    const s = await sql<{
      cost_cents: number;
    }>`select cost_cents from sales where id = ${res.sale_id}`.execute(db);
    expect(s.rows[0]!.cost_cents).toBe(300);
  });
});
