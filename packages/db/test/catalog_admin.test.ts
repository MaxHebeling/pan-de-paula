import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll, createStaff, createProduct, sql, withStaff, callFn } from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let croissant: string;
let harina: string;
let mantequilla: string;

async function createIngredient(name: string, unit: "g" | "ml" | "pz", packageQty: number, priceCents: number) {
  const r = await sql<{ id: string }>`insert into ingredients(name, base_unit) values (${name}, ${unit}::base_unit) returning id`.execute(db);
  const id = r.rows[0]!.id;
  await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${id}, ${packageQty}, ${priceCents})`.execute(db);
  return id;
}

async function costOf(productId: string) {
  const r = await sql<{ c: number | null }>`select product_cost_cents(${productId}) as c`.execute(db);
  return r.rows[0]!.c;
}

async function priceOf(productId: string, channel: "web" | "pos") {
  const r = await sql<{ p: number | null }>`select current_price_cents(${productId}, ${channel}::price_channel) as p`.execute(db);
  return r.rows[0]!.p;
}

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  croissant = await createProduct(db, "Croissant", 4500);
  harina = await createIngredient("Harina", "g", 1000, 2200); // 0.022 MXN/g
  mantequilla = await createIngredient("Mantequilla", "g", 1808, 40000); // ~0.2212 MXN/g
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("upsert_recipe + product_cost_cents", () => {
  it("crea la receta, calcula el costo por pieza y reemplaza líneas al re-guardar", async () => {
    const items = JSON.stringify([
      { ingredient_id: harina, qty: 1000 },
      { ingredient_id: mantequilla, qty: 500, note: "fría" },
    ]);
    const recipeId = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "upsert_recipe", [croissant, 12, "12 piezas", 6000, 0, null, items]),
    );
    expect(recipeId).toBeTruthy();
    // ingredientes: 1000*0.022 + 500*(400/1808) = 22 + 110.619... = 132.6195 MXN → 13261.95 c + 6000 labor = 19261.95 / 12 = 1605.16 → 1605
    expect(await costOf(croissant)).toBe(1605);

    const again = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "upsert_recipe", [croissant, 10, null, 0, 0, null, JSON.stringify([{ ingredient_id: harina, qty: 500 }])]),
    );
    expect(again).toBe(recipeId);
    const lines = await sql<{ n: number; version: number }>`select (select count(*)::int from recipe_items where recipe_id = ${recipeId}) as n, version from recipes where id = ${recipeId}`.execute(db);
    expect(lines.rows[0]).toEqual({ n: 1, version: 2 });
    expect(await costOf(croissant)).toBe(110); // 500*0.022 = 11 MXN / 10 = 1.10
  });

  it("rechaza rendimiento cero y cantidades no positivas", async () => {
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "upsert_recipe", [croissant, 0, null, 0, 0, null, "[]"])),
    ).rejects.toThrow(/rendimiento/i);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "upsert_recipe", [croissant, 1, null, 0, 0, null, JSON.stringify([{ ingredient_id: harina, qty: 0 }])]),
      ),
    ).rejects.toThrow(/mayor a cero/);
  });
});

describe("record_ingredient_price + product_cost_impact", () => {
  beforeEach(async () => {
    await withStaff(db, staff, (trx) =>
      callFn(trx, "upsert_recipe", [
        croissant, 12, null, 0, 0, null,
        JSON.stringify([{ ingredient_id: harina, qty: 1000 }, { ingredient_id: mantequilla, qty: 500 }]),
      ]),
    );
  });

  it("previsualiza el impacto del nuevo costo unitario en los productos afectados", async () => {
    const before = await costOf(croissant); // 1105
    expect(before).toBe(1105);
    const r = await sql<{ product_id: string; current_cost_cents: number; new_cost_cents: number }>`
      select product_id, current_cost_cents, new_cost_cents from product_cost_impact(${mantequilla}, 0.30)`.execute(db);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.product_id).toBe(croissant);
    expect(r.rows[0]!.current_cost_cents).toBe(1105);
    // 1000*0.022 + 500*0.30 = 22 + 150 = 172 MXN / 12 = 14.333 → 1433
    expect(r.rows[0]!.new_cost_cents).toBe(1433);
  });

  it("registra el precio en el historial, recalcula el costo y opcionalmente suma stock", async () => {
    const id = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "record_ingredient_price", [mantequilla, 1000, 30000, "Barra 1 kg", null, true, 2]),
    );
    expect(id).toBeTruthy();
    const price = await sql<{ unit_cost: string; source: string; created_by: string }>`select unit_cost, source, created_by from ingredient_prices where id = ${id}`.execute(db);
    expect(Number(price.rows[0]!.unit_cost)).toBeCloseTo(0.3, 8);
    expect(price.rows[0]!.source).toBe("purchase");
    expect(price.rows[0]!.created_by).toBe(staff);
    expect(await costOf(croissant)).toBe(1433);
    const stock = await sql<{ stock_qty: string }>`select stock_qty from ingredients where id = ${mantequilla}`.execute(db);
    expect(Number(stock.rows[0]!.stock_qty)).toBe(2000);
    const mv = await sql<{ type: string; qty: string }>`select type, qty from ingredient_movements where ingredient_id = ${mantequilla}`.execute(db);
    expect(mv.rows).toEqual([{ type: "PURCHASE", qty: "2000.000" }]);
  });

  it("valida contenido y precio", async () => {
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "record_ingredient_price", [mantequilla, 0, 100, null, null, false, 1])),
    ).rejects.toThrow(/contenido/);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "record_ingredient_price", [mantequilla, 10, -5, null, null, false, 1])),
    ).rejects.toThrow(/precio/);
  });
});

describe("precios: set_regular_price / create_promotion / end_promotion", () => {
  it("cierra el regular anterior y activa el nuevo sin tocar el histórico", async () => {
    const first = await sql<{ id: string }>`select id from product_prices where product_id = ${croissant}`.execute(db);
    const newId = await withStaff(db, staff, (trx) => callFn<string>(trx, "set_regular_price", [croissant, "all", 4800, "Ajuste 2026"]));
    expect(await priceOf(croissant, "pos")).toBe(4800);
    const rows = await sql<{ id: string; price_cents: number; valid_to: Date | null; created_by: string | null }>`
      select id, price_cents, valid_to, created_by from product_prices where product_id = ${croissant} order by valid_from`.execute(db);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.id).toBe(first.rows[0]!.id);
    expect(rows.rows[0]!.price_cents).toBe(4500);
    expect(rows.rows[0]!.valid_to).not.toBeNull();
    expect(rows.rows[1]!.id).toBe(newId);
    expect(rows.rows[1]!.created_by).toBe(staff);
  });

  it("precio por canal: pos distinto de web", async () => {
    await withStaff(db, staff, (trx) => callFn(trx, "set_regular_price", [croissant, "web", 5000, null]));
    expect(await priceOf(croissant, "web")).toBe(5000);
    expect(await priceOf(croissant, "pos")).toBe(4500);
  });

  it("promoción vigente gana al regular y se puede terminar anticipadamente", async () => {
    const promoId = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_promotion", [croissant, "all", 3900, new Date(Date.now() - 1000).toISOString(), null, "Promo"]),
    );
    expect(await priceOf(croissant, "pos")).toBe(3900);
    await withStaff(db, staff, (trx) => callFn(trx, "end_promotion", [promoId]));
    expect(await priceOf(croissant, "pos")).toBe(4500);
    const row = await sql<{ valid_to: Date | null }>`select valid_to from product_prices where id = ${promoId}`.execute(db);
    expect(row.rows[0]!.valid_to).not.toBeNull();
    await expect(withStaff(db, staff, (trx) => callFn(trx, "end_promotion", [promoId]))).rejects.toThrow(/ya terminó/);
  });

  it("una promoción futura que se cancela se elimina y una promo >= regular se rechaza", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const promoId = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_promotion", [croissant, "web", 4000, future, null, null]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "end_promotion", [promoId]));
    const gone = await sql<{ n: number }>`select count(*)::int as n from product_prices where id = ${promoId}`.execute(db);
    expect(gone.rows[0]!.n).toBe(0);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "create_promotion", [croissant, "all", 4500, new Date().toISOString(), null, null])),
    ).rejects.toThrow(/menor al precio regular/);
  });
});

describe("product_has_sales", () => {
  it("es falso sin ventas y verdadero cuando el producto (o una variante) fue vendido", async () => {
    const r0 = await sql<{ h: boolean }>`select product_has_sales(${croissant}) as h`.execute(db);
    expect(r0.rows[0]!.h).toBe(false);
    const variant = await sql<{ id: string }>`insert into products(name, slug, parent_id, variant_label) values ('Croissant mini', 'croissant-mini', ${croissant}, 'Mini') returning id`.execute(db);
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [variant.rows[0]!.id, 5, null, null]));
    await sql`insert into product_prices(product_id, price_cents) values (${variant.rows[0]!.id}, 2000)`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: variant.rows[0]!.id, qty: 1 }],
          payments: [{ provider: "cash", method: "cash", amount_cents: 2000, tendered_cents: 2000 }],
          idempotency_key: "k-test-1",
        }),
      ]),
    );
    const r1 = await sql<{ h: boolean }>`select product_has_sales(${croissant}) as h`.execute(db);
    expect(r1.rows[0]!.h).toBe(true);
  });
});
