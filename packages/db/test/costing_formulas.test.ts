/**
 * 0011_costing_formulas: merma, mano de obra por hora, indirectos como % de insumos,
 * precio sugerido (redondeo hacia arriba), desglose de fórmula, edición celda por celda y parámetros globales.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let croissant: string;
let harina: string;
let mantequilla: string;

type Breakdown = {
  has_recipe: boolean;
  lines: Array<{ ingredient_id: string; qty: string | number; unit_cost: number | null }>;
  ingredients_mxn: number;
  labor: { mode: string; cents: number; minutes: number | null };
  overhead: { mode: string; cents: number; pct_bps: number };
  yield_qty: number;
  waste_bps: number;
  waste_source: string;
  batch_cents: number;
  cost_per_piece_cents: number | null;
  pos_price_cents: number | null;
  web_price_cents: number | null;
  pos_margin_bps: number | null;
  target_margin_bps: number;
  target_source: string;
  suggested_raw_cents: number | null;
  suggested_price_cents: number | null;
  has_missing_prices: boolean;
  settings: { price_rounding_cents: number; default_target_margin_bps: number };
  version: number | null;
};

async function createIngredient(
  name: string,
  unit: "g" | "ml" | "pz",
  packageQty: number,
  priceCents: number,
) {
  const r = await sql<{
    id: string;
  }>`insert into ingredients(name, base_unit) values (${name}, ${unit}::base_unit) returning id`.execute(
    db,
  );
  const id = r.rows[0]!.id;
  await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${id}, ${packageQty}, ${priceCents})`.execute(
    db,
  );
  return id;
}

const costOf = async (productId: string) =>
  (await sql<{ c: number | null }>`select product_cost_cents(${productId}) as c`.execute(db))
    .rows[0]!.c;
const suggestedOf = async (productId: string, margin: number | null = null) =>
  (
    await sql<{
      s: number | null;
    }>`select suggested_price_cents(${productId}, ${margin}::integer) as s`.execute(db)
  ).rows[0]!.s;
const breakdownOf = async (productId: string) =>
  (
    await sql<{
      b: Breakdown | null;
    }>`select recipe_formula_breakdown(${productId}) as b`.execute(db)
  ).rows[0]!.b;
const settings = (patch: string) => sql.raw(`update costing_settings set ${patch} where id = 1`);
const params = (productId: string, patch: Record<string, unknown>) =>
  withStaff(db, staff, (trx) =>
    callFn<Breakdown>(trx, "update_recipe_params", [productId, JSON.stringify(patch)]),
  );

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  croissant = await createProduct(db, "Croissant", 4500);
  harina = await createIngredient("Harina", "g", 1000, 2200); // 0.022 MXN/g
  mantequilla = await createIngredient("Mantequilla", "g", 1808, 40000); // 0.22124 MXN/g
  // 1000 g harina + 500 g mantequilla = 22 + 110.6195 = 132.6195 MXN; MO 6000 c; rinde 12 → 1605
  await withStaff(db, staff, (trx) =>
    callFn(trx, "upsert_recipe", [
      croissant,
      12,
      "12 piezas",
      6000,
      0,
      null,
      JSON.stringify([
        { ingredient_id: harina, qty: 1000 },
        { ingredient_id: mantequilla, qty: 500 },
      ]),
    ]),
  );
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("product_cost_cents con parámetros", () => {
  it("sin overrides ni parámetros el costo es idéntico a la fórmula original", async () => {
    expect(await costOf(croissant)).toBe(1605);
    const view = await sql<{
      waste_bps: number;
      target_margin_bps: number;
      suggested_price_cents: number;
      web_price_cents: number;
      labor_effective_cents: string;
    }>`select waste_bps, target_margin_bps, suggested_price_cents, web_price_cents, labor_effective_cents from recipe_costing where product_id = ${croissant}`.execute(
      db,
    );
    expect(view.rows[0]).toMatchObject({
      waste_bps: 0,
      target_margin_bps: 6000,
      suggested_price_cents: 4100, // 1605 / 0.4 = 4012.5 → múltiplo de $1 hacia arriba
      web_price_cents: 4500,
    });
    expect(Number(view.rows[0]!.labor_effective_cents)).toBe(6000);
  });

  it("merma: override de receta y default global; el override gana", async () => {
    await params(croissant, { waste_bps: 1000 });
    // 19261.95 / 12 = 1605.1625 × 1.10 = 1765.68 → 1766
    expect(await costOf(croissant)).toBe(1766);
    await params(croissant, { waste_bps: null });
    expect(await costOf(croissant)).toBe(1605);
    await settings("default_waste_bps = 500").execute(db);
    expect(await costOf(croissant)).toBe(1685); // × 1.05 = 1685.42
    await params(croissant, { waste_bps: 1000 });
    expect(await costOf(croissant)).toBe(1766);
  });

  it("mano de obra por hora: minutos ÷ 60 × tarifa; sin minutos cae al monto por lote", async () => {
    await settings("labor_mode = 'per_hour', labor_rate_cents_per_hour = 12000").execute(db);
    expect(await costOf(croissant)).toBe(1605); // labor_minutes null → 6000 por lote
    await params(croissant, { labor_minutes: 90 });
    // 13261.95 + 18000 = 31261.95 / 12 = 2605.16 → 2605
    expect(await costOf(croissant)).toBe(2605);
    const b = (await breakdownOf(croissant))!;
    expect(b.labor).toMatchObject({ mode: "per_hour", minutes: 90, cents: 18000 });
    await settings("labor_mode = 'per_batch'").execute(db);
    expect(await costOf(croissant)).toBe(1605); // los minutos se conservan pero no aplican
  });

  it("indirectos como % de insumos", async () => {
    await settings("overhead_mode = 'pct_of_ingredients', overhead_pct_bps = 1500").execute(db);
    // 13261.95 × 0.15 = 1989.29; (13261.95 + 6000 + 1989.29) / 12 = 1770.94 → 1771
    expect(await costOf(croissant)).toBe(1771);
    const b = (await breakdownOf(croissant))!;
    expect(b.overhead.mode).toBe("pct_of_ingredients");
    expect(Number(b.overhead.cents)).toBeCloseTo(1989.2925, 3);
  });

  it("product_cost_impact usa la misma fórmula (merma + % indirectos) que product_cost_cents", async () => {
    await settings(
      "overhead_mode = 'pct_of_ingredients', overhead_pct_bps = 1000, default_waste_bps = 800",
    ).execute(db);
    const before = await costOf(croissant);
    const impact = await sql<{
      current_cost_cents: number;
      new_cost_cents: number;
    }>`select current_cost_cents, new_cost_cents from product_cost_impact(${harina}, 0.03)`.execute(
      db,
    );
    expect(impact.rows[0]!.current_cost_cents).toBe(before);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_ingredient_price", [harina, 1000, 3000, null, null, false, 1]),
    );
    expect(await costOf(croissant)).toBe(impact.rows[0]!.new_cost_cents);
    expect(await costOf(croissant)).toBeGreaterThan(before!);
  });
});

describe("suggested_price_cents", () => {
  it("redondea HACIA ARRIBA al múltiplo configurado y respeta el múltiplo exacto", async () => {
    expect(await suggestedOf(croissant)).toBe(4100); // 4012.5 → 4100
    await settings("price_rounding_cents = 50").execute(db);
    expect(await suggestedOf(croissant)).toBe(4050);
    await settings("price_rounding_cents = 500").execute(db);
    expect(await suggestedOf(croissant)).toBe(4500);
    await settings("price_rounding_cents = 1000").execute(db);
    expect(await suggestedOf(croissant)).toBe(5000);
    await settings("price_rounding_cents = 100").execute(db);
    // costo 2000 (MO 24000 / 12) con margen 60% → 5000 exacto: no sube a 5100
    await params(croissant, { labor_cents: 24000 });
    await sql`delete from recipe_items where recipe_id = (select id from recipes where product_id = ${croissant})`.execute(
      db,
    );
    expect(await costOf(croissant)).toBe(2000);
    expect(await suggestedOf(croissant)).toBe(5000);
  });

  it("margen: parámetro explícito > override de receta > default global", async () => {
    expect(await suggestedOf(croissant, 7000)).toBe(5400); // 1605 / 0.3 = 5350 → 5400
    await params(croissant, { target_margin_bps: 5000 });
    expect(await suggestedOf(croissant)).toBe(3300); // 3210 → 3300
    expect(await suggestedOf(croissant, 7000)).toBe(5400);
    await params(croissant, { target_margin_bps: null });
    await settings("default_target_margin_bps = 7000").execute(db);
    expect(await suggestedOf(croissant)).toBe(5400);
  });

  it("NULL sin receta y con margen ≥ 100%", async () => {
    const sinReceta = await createProduct(db, "Sin receta", 1000);
    expect(await suggestedOf(sinReceta)).toBeNull();
    expect(await suggestedOf(croissant, 10000)).toBeNull();
  });
});

describe("recipe_formula_breakdown", () => {
  it("devuelve todos los términos con sus valores", async () => {
    const b = (await breakdownOf(croissant))!;
    expect(b.has_recipe).toBe(true);
    expect(b.lines).toHaveLength(2);
    expect(Number(b.ingredients_mxn)).toBeCloseTo(132.6195, 3);
    expect(Number(b.labor.cents)).toBe(6000);
    expect(Number(b.overhead.cents)).toBe(0);
    expect(Number(b.yield_qty)).toBe(12);
    expect(b.waste_bps).toBe(0);
    expect(b.waste_source).toBe("default");
    expect(Number(b.batch_cents)).toBeCloseTo(19261.95, 2);
    expect(b.cost_per_piece_cents).toBe(1605);
    expect(b.pos_price_cents).toBe(4500);
    expect(b.pos_margin_bps).toBe(6433); // (4500 − 1605) / 4500
    expect(b.target_margin_bps).toBe(6000);
    expect(b.target_source).toBe("default");
    expect(Number(b.suggested_raw_cents)).toBeCloseTo(4012.5, 3);
    expect(b.suggested_price_cents).toBe(4100);
    expect(b.has_missing_prices).toBe(false);
    expect(b.settings.price_rounding_cents).toBe(100);
  });

  it("marca overrides de receta e insumos sin precio; producto sin receta y producto inexistente", async () => {
    await params(croissant, { target_margin_bps: 7000, waste_bps: 500 });
    const sinPrecio = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit) values ('Vainilla', 'ml') returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) select id, ${sinPrecio.rows[0]!.id}, 5 from recipes where product_id = ${croissant}`.execute(
      db,
    );
    const b = (await breakdownOf(croissant))!;
    expect(b.target_source).toBe("recipe");
    expect(b.waste_source).toBe("recipe");
    expect(b.has_missing_prices).toBe(true);
    expect(b.lines.find((l) => l.ingredient_id === sinPrecio.rows[0]!.id)?.unit_cost).toBeNull();

    const sinReceta = await createProduct(db, "Sin receta", 1000);
    const b2 = (await breakdownOf(sinReceta))!;
    expect(b2.has_recipe).toBe(false);
    expect(b2.cost_per_piece_cents).toBeNull();
    expect(b2.pos_price_cents).toBe(1000);
    expect(b2.target_margin_bps).toBe(6000);
    expect(await breakdownOf("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("update_recipe_params (hoja de costos)", () => {
  it("edita celdas, sube la versión, emite evento y devuelve el desglose", async () => {
    const v0 = (await breakdownOf(croissant))!.version!;
    const b = await params(croissant, { yield_qty: 6, overhead_cents: 1200 });
    // (13261.95 + 6000 + 1200) / 6 = 3410.33 → 3410
    expect(b.cost_per_piece_cents).toBe(3410);
    expect(await costOf(croissant)).toBe(3410);
    expect(b.version).toBe(v0 + 1);
    const ev = await sql<{
      n: number;
    }>`select count(*)::int as n from domain_events where event_type = 'RECIPE_UPDATED' and aggregate_id = ${croissant} and payload ? 'patch'`.execute(
      db,
    );
    expect(ev.rows[0]!.n).toBe(1);
  });

  it("crea la receta si el producto no tenía y valida los rangos", async () => {
    const nuevo = await createProduct(db, "Nuevo", 5000);
    const b = await params(nuevo, { labor_cents: 10000, yield_qty: 10 });
    expect(b.has_recipe).toBe(true);
    expect(b.cost_per_piece_cents).toBe(1000);
    await expect(params(nuevo, { yield_qty: 0 })).rejects.toThrow(/rendimiento/);
    await expect(params(nuevo, { waste_bps: 20000 })).rejects.toThrow(/merma/i);
    await expect(params(nuevo, { target_margin_bps: 9950 })).rejects.toThrow(/margen/i);
    await expect(params(nuevo, { labor_cents: -1 })).rejects.toThrow(/negativa/);
    await expect(params("00000000-0000-0000-0000-000000000000", { yield_qty: 1 })).rejects.toThrow(
      /no encontrado/,
    );
  });

  it("upsert_recipe_v2 guarda overrides y upsert_recipe (legado) los conserva", async () => {
    const items = JSON.stringify([{ ingredient_id: harina, qty: 1000 }]);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "upsert_recipe_v2", [croissant, 10, null, 0, 0, null, items, 1000, 7000, 45]),
    );
    let r = await db
      .selectFrom("recipes")
      .select(["waste_bps", "target_margin_bps", "labor_minutes"])
      .where("product_id", "=", croissant)
      .executeTakeFirstOrThrow();
    expect(r).toMatchObject({ waste_bps: 1000, target_margin_bps: 7000 });
    expect(Number(r.labor_minutes)).toBe(45);
    // 2200 / 10 × 1.1 = 242
    expect(await costOf(croissant)).toBe(242);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "upsert_recipe", [croissant, 10, null, 0, 0, null, items]),
    );
    r = await db
      .selectFrom("recipes")
      .select(["waste_bps", "target_margin_bps", "labor_minutes"])
      .where("product_id", "=", croissant)
      .executeTakeFirstOrThrow();
    expect(r).toMatchObject({ waste_bps: 1000, target_margin_bps: 7000 });
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "upsert_recipe_v2", [croissant, 10, null, 0, 0, null, items, null, 9950, null]),
      ),
    ).rejects.toThrow(/margen/i);
  });
});

describe("costing_settings", () => {
  it("valida el múltiplo de redondeo y los modos; audita cambios con el staff", async () => {
    await expect(settings("price_rounding_cents = 75").execute(db)).rejects.toThrow();
    await expect(settings("labor_mode = 'per_piece'").execute(db)).rejects.toThrow();
    await expect(settings("default_target_margin_bps = 10000").execute(db)).rejects.toThrow();
    await withStaff(db, staff, (trx) =>
      trx
        .updateTable("costing_settings")
        .set({ default_target_margin_bps: 7000, price_rounding_cents: 500 })
        .where("id", "=", 1)
        .execute(),
    );
    const audit = await sql<{
      staff_id: string;
      new_data: { default_target_margin_bps: number };
    }>`select staff_id, new_data from audit_logs where entity = 'costing_settings' order by id desc limit 1`.execute(
      db,
    );
    expect(audit.rows[0]!.staff_id).toBe(staff);
    expect(audit.rows[0]!.new_data.default_target_margin_bps).toBe(7000);
    expect(await suggestedOf(croissant)).toBe(5500); // 1605 / 0.3 = 5350 → múltiplo de $5
  });
});
