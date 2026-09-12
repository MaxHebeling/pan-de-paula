/**
 * Paridad entre el dominio TypeScript y la base de datos:
 * si alguien cambia una regla en un lado y no en el otro, esta suite falla.
 */
import { afterAll, describe, expect, it } from "vitest";
import { ORDER_STATUSES, ORDER_TRANSITIONS, pointsForPurchase, resolveTier, costRecipe, unitCost } from "@pdp/domain";
import { testDb, sql } from "./helpers.ts";

const { db, pool } = testDb();
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("paridad dominio ↔ SQL", () => {
  it("matriz de transiciones de pedido idéntica a order_transition_allowed()", async () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        if (from === to) continue;
        const r = await sql<{ ok: boolean }>`select order_transition_allowed(${from}::order_status, ${to}::order_status) as ok`.execute(db);
        expect(r.rows[0]!.ok, `${from} → ${to}`).toBe(ORDER_TRANSITIONS[from].includes(to));
      }
    }
  });

  it("los enums de estado de pedido coinciden con el tipo SQL", async () => {
    const r = await sql<{ v: string }>`select unnest(enum_range(null::order_status))::text as v`.execute(db);
    expect(r.rows.map((x) => x.v).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it("niveles de fidelización: resolveTier coincide con loyalty_tiers de la base", async () => {
    const tiers = await sql<{ key: string; name: string; rank: number; min_orders: number; min_spent_cents: number; min_lifetime_points: number }>`select key, name, rank, min_orders, min_spent_cents, min_lifetime_points from loyalty_tiers`.execute(db);
    const t = tiers.rows.map((x) => ({ key: x.key, name: x.name, rank: x.rank, minOrders: x.min_orders, minSpentCents: Number(x.min_spent_cents), minLifetimePoints: x.min_lifetime_points }));
    expect(resolveTier(t, { totalOrders: 0, totalSpentCents: 0, lifetimePoints: 0 })?.key).toBe("new");
    expect(resolveTier(t, { totalOrders: 15, totalSpentCents: 500000, lifetimePoints: 0 })?.key).toBe("vip");
  });

  it("puntos: pointsForPurchase coincide con la configuración por defecto del programa (1 punto por $10)", async () => {
    const p = await sql<{ points_per_unit: number; unit_cents: number; min_purchase_cents: number; birthday_multiplier: string; rounding: "floor" | "round"; is_active: boolean }>`select points_per_unit, unit_cents, min_purchase_cents, birthday_multiplier, rounding, is_active from loyalty_program where id = 1`.execute(db);
    const prog = p.rows[0]!;
    const program = { isActive: prog.is_active, pointsPerUnit: prog.points_per_unit, unitCents: prog.unit_cents, minPurchaseCents: prog.min_purchase_cents, birthdayMultiplier: Number(prog.birthday_multiplier), rounding: prog.rounding };
    expect(pointsForPurchase(program, 13500)).toBe(13);
  });

  it("costeo: costRecipe coincide con product_cost_cents para la misma receta", async () => {
    await sql`truncate recipe_items, recipes, ingredient_prices, ingredients, product_prices, products cascade`.execute(db);
    const prod = await sql<{ id: string }>`insert into products(name, slug) values ('Paridad', 'paridad-test') returning id`.execute(db);
    const a = await sql<{ id: string }>`insert into ingredients(name, base_unit) values ('A', 'g') returning id`.execute(db);
    const b = await sql<{ id: string }>`insert into ingredients(name, base_unit) values ('B', 'pz') returning id`.execute(db);
    await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents) values (${a.rows[0]!.id}, 1808, 40000), (${b.rows[0]!.id}, 30, 9500)`.execute(db);
    const rec = await sql<{ id: string }>`insert into recipes(product_id, yield_qty, labor_cents, overhead_cents) values (${prod.rows[0]!.id}, 12, 3000, 1200) returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${a.rows[0]!.id}, 500), (${rec.rows[0]!.id}, ${b.rows[0]!.id}, 2)`.execute(db);
    const sqlCost = await sql<{ c: number }>`select product_cost_cents(${prod.rows[0]!.id}) as c`.execute(db);
    const ts = costRecipe({
      yieldQty: 12, laborCents: 3000, overheadCents: 1200,
      lines: [
        { ingredientId: "a", qty: 500, unitCost: unitCost({ priceCents: 40000, packageQty: 1808 }) },
        { ingredientId: "b", qty: 2, unitCost: unitCost({ priceCents: 9500, packageQty: 30 }) },
      ],
    });
    expect(ts.costPerPieceCents).toBe(sqlCost.rows[0]!.c);
  });
});
