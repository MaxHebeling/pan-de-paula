/**
 * Auditoría Catálogo · Clientes · Fidelización · Cupones · Reportes (0014_audit_catalog.sql).
 * Cada bloque reproduce un caso que falló en la auditoría y fija el comportamiento corregido,
 * más la matriz de casos límite que la UI no puede garantizar por sí sola.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let croissant: string;
let galleta: string;
let harina: string;

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

const asStaff = <T>(fn: string, args: unknown[]) =>
  withStaff(db, staff, (trx) => callFn<T>(trx, fn, args));

async function customerRow(id: string) {
  const r = await sql<{
    points_balance: number;
    lifetime_points: number;
    tier_key: string | null;
    total_orders: number;
    phone: string | null;
  }>`select points_balance, lifetime_points, tier_key, total_orders, phone::text as phone from customers where id = ${id}`.execute(
    db,
  );
  return r.rows[0]!;
}

async function priceOf(productId: string, channel: "web" | "pos") {
  const r = await sql<{
    p: number | null;
  }>`select current_price_cents(${productId}, ${channel}::price_channel) as p`.execute(db);
  return r.rows[0]!.p;
}

beforeEach(async () => {
  await truncateAll(db);
  await sql`update loyalty_program set rounding = 'floor', points_expire_days = null`.execute(db);
  staff = await createStaff(db);
  croissant = await createProduct(db, "Croissant", 4500);
  galleta = await createProduct(db, "Galleta", 2500);
  harina = await createIngredient("Harina", "g", 1000, 2200);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

// ── Ledger de puntos ────────────────────────────────────────────────────────
describe("loyalty_post: lifetime_points solo crece con puntos nuevos", () => {
  it("earn/bonus/adjust suman al histórico; redeem y reversal no lo inflan", async () => {
    const { customer_id: c } = await createCustomer(db);
    await asStaff("loyalty_post", [c, "earn", 100, null, null, "compra"]);
    await asStaff("loyalty_post", [c, "bonus", 10, null, null, "bono"]);
    await asStaff("loyalty_post", [c, "adjust", 5, null, null, "ajuste"]);
    expect(await customerRow(c)).toMatchObject({ points_balance: 115, lifetime_points: 115 });
    await asStaff("loyalty_post", [c, "redeem", -40, null, null, "canje"]);
    await asStaff("loyalty_post", [c, "reversal", 40, null, null, "cancelación de canje"]);
    // Antes: lifetime 155 (la reversa volvía a contar los 40). Ahora: 115.
    expect(await customerRow(c)).toMatchObject({ points_balance: 115, lifetime_points: 115 });
    await expect(
      asStaff("loyalty_post", [c, "adjust", -200, null, null, "negativo insuficiente"]),
    ).rejects.toThrow(/insuficientes/);
    expect((await customerRow(c)).points_balance).toBe(115);
  });

  it("cancelar un canje devuelve los puntos sin subir de nivel artificialmente", async () => {
    await sql`update loyalty_tiers set min_lifetime_points = 150, min_orders = 0, min_spent_cents = 0 where key = 'frequent'`.execute(
      db,
    );
    const { customer_id: c } = await createCustomer(db);
    const reward = await sql<{
      id: string;
    }>`insert into rewards(name, kind, points_cost, value_cents) values ('Café', 'discount_amount', 100, 3000) returning id`.execute(
      db,
    );
    await asStaff("loyalty_post", [c, "earn", 120, null, null, "compra"]);
    await asStaff("recompute_customer_tier", [c]);
    expect((await customerRow(c)).tier_key).toBe("new");
    const red = await asStaff<{ redemption_id: string; code: string }>("redeem_reward", [
      c,
      reward.rows[0]!.id,
    ]);
    expect((await customerRow(c)).points_balance).toBe(20);
    // Cancelación (misma secuencia que cancelRedemptionAction)
    await withStaff(db, staff, async (trx) => {
      await sql`update reward_redemptions set status = 'cancelled' where id = ${red.redemption_id}`.execute(
        trx,
      );
      await callFn(trx, "loyalty_post", [
        c,
        "reversal",
        100,
        null,
        red.redemption_id,
        "Cancelación de canje",
      ]);
      await callFn(trx, "recompute_customer_tier", [c]);
    });
    const after = await customerRow(c);
    expect(after.points_balance).toBe(120);
    expect(after.lifetime_points).toBe(120); // no 220
    expect(after.tier_key).toBe("new"); // antes: subía a 'frequent' con 220 "históricos"
    // Segunda cancelación del mismo canje no procede (ya no está 'issued')
    const st = await sql<{
      status: string;
    }>`select status from reward_redemptions where id = ${red.redemption_id}`.execute(db);
    expect(st.rows[0]!.status).toBe("cancelled");
  });

  it("redeem_reward: sin puntos, nivel insuficiente y fuera de vigencia", async () => {
    const { customer_id: c } = await createCustomer(db);
    const mk = async (extra: string) =>
      (
        await sql<{
          id: string;
        }>`insert into rewards(name, kind, points_cost, value_cents, min_tier_key, starts_at, ends_at)
          values ('R', 'discount_amount', 50, 1000, ${extra === "tier" ? "vip" : null}, ${extra === "future" ? sql`now() + interval '1 day'` : null}, ${extra === "past" ? sql`now() - interval '1 day'` : null}) returning id`.execute(
          db,
        )
      ).rows[0]!.id;
    const plain = await mk("");
    await expect(asStaff("redeem_reward", [c, plain])).rejects.toThrow(/insuficientes/);
    await asStaff("loyalty_post", [c, "earn", 500, null, null, "x"]);
    await expect(asStaff("redeem_reward", [c, await mk("tier")])).rejects.toThrow(/Nivel/);
    await expect(asStaff("redeem_reward", [c, await mk("future")])).rejects.toThrow(/vigencia/);
    await expect(asStaff("redeem_reward", [c, await mk("past")])).rejects.toThrow(/vigencia/);
    const ok = await asStaff<{ code: string }>("redeem_reward", [c, plain]);
    expect(ok.code).toMatch(/^[A-Z0-9]{8}$/);
    expect((await customerRow(c)).points_balance).toBe(450);
  });
});

// ── Teléfonos / dedupe ──────────────────────────────────────────────────────
describe("normalize_mx_phone + register_customer + find_customer", () => {
  it("+52, 52, +521, 01 y espacios se normalizan a 10 dígitos; internacionales conservan E.164", async () => {
    const r = await sql<{
      a: string;
      b: string;
      c: string;
      d: string;
      e: string;
      f: string | null;
    }>`
      select normalize_mx_phone('+52 664 123 4567') a, normalize_mx_phone('52 664 123 4567') b,
             normalize_mx_phone('+52 1 664 123 4567') c, normalize_mx_phone('01 664 123 4567') d,
             normalize_mx_phone('+1 (619) 555-0100') e, normalize_mx_phone('  ') f`.execute(db);
    expect(r.rows[0]).toEqual({
      a: "6641234567",
      b: "6641234567",
      c: "6641234567",
      d: "6641234567",
      e: "+16195550100",
      f: null,
    });
  });

  it("registrar con +52 reutiliza al cliente de 10 dígitos (y viceversa); email en mayúsculas dedupe", async () => {
    const a = await asStaff<{ customer_id: string; created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Ana", phone: "664 000 1111" }),
    ]);
    const b = await asStaff<{ customer_id: string; created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Ana (móvil)", phone: "+52 664 000 1111" }),
    ]);
    const c = await asStaff<{ customer_id: string; created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Ana", phone: "52 664 000 1111" }),
    ]);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ customer_id: a.customer_id, created: false });
    expect(c).toMatchObject({ customer_id: a.customer_id, created: false });
    expect((await customerRow(a.customer_id)).phone).toBe("6640001111");
    const d = await asStaff<{ customer_id: string; created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Beto", email: "BETO@Example.COM" }),
    ]);
    const e = await asStaff<{ customer_id: string; created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Beto", email: " beto@example.com " }),
    ]);
    expect(e).toMatchObject({ customer_id: d.customer_id, created: false });
    // Un cliente histórico guardado con +52 también se encuentra desde el formato de 10 dígitos
    await sql`insert into customers(full_name, phone) values ('Legacy', '+526649998877')`.execute(
      db,
    );
    const f = await asStaff<{ created: boolean }>("register_customer", [
      JSON.stringify({ full_name: "Legacy 2", phone: "6649998877" }),
    ]);
    expect(f.created).toBe(false);
    const found = await sql<{
      full_name: string;
    }>`select full_name from find_customer('+52 664 999 8877')`.execute(db);
    expect(found.rows[0]?.full_name).toBe("Legacy");
    const byCode = await sql<{
      full_name: string;
    }>`select full_name from find_customer(lower((select public_code from customers where id = ${a.customer_id})))`.execute(
      db,
    );
    expect(byCode.rows[0]?.full_name).toBe("Ana");
    const none = await sql<{ n: number }>`select count(*)::int n from find_customer('12')`.execute(
      db,
    );
    expect(none.rows[0]!.n).toBe(0);
  });
});

// ── Promociones ─────────────────────────────────────────────────────────────
describe("create_promotion: vigencia y solapamientos", () => {
  it("rechaza promociones ya vencidas, fin ≤ inicio y solapadas en el mismo canal", async () => {
    await expect(
      asStaff("create_promotion", [
        croissant,
        "all",
        3000,
        new Date(Date.now() - 864e5 * 3).toISOString(),
        new Date(Date.now() - 864e5).toISOString(),
        "pasada",
      ]),
    ).rejects.toThrow(/ya habría terminado/);
    await expect(
      asStaff("create_promotion", [
        croissant,
        "all",
        3000,
        new Date(Date.now() + 864e5 * 2).toISOString(),
        new Date(Date.now() + 864e5).toISOString(),
        "invertida",
      ]),
    ).rejects.toThrow(/posterior al inicio/);
    // valid_from nulo: ahora funciona (antes fallaba con el check constraint crudo)
    const a = await asStaff<string>("create_promotion", [
      croissant,
      "all",
      3000,
      null,
      new Date(Date.now() + 864e5).toISOString(),
      "A",
    ]);
    expect(a).toBeTruthy();
    expect(await priceOf(croissant, "pos")).toBe(3000);
    // Solapada en el mismo canal (y más cara): antes ganaba silenciosamente; ahora se rechaza.
    await expect(
      asStaff("create_promotion", [
        croissant,
        "all",
        3500,
        new Date().toISOString(),
        new Date(Date.now() + 864e5 * 2).toISOString(),
        "B",
      ]),
    ).rejects.toThrow(/Ya existe la promoción "A"/);
    expect(await priceOf(croissant, "pos")).toBe(3000);
    // Otro canal sí puede tener su propia promo; POS y web resuelven distinto.
    await asStaff("create_promotion", [
      croissant,
      "web",
      2800,
      new Date().toISOString(),
      null,
      "web",
    ]);
    expect(await priceOf(croissant, "web")).toBe(2800);
    expect(await priceOf(croissant, "pos")).toBe(3000);
    const cat = await sql<{
      web_price_cents: number;
      pos_price_cents: number;
    }>`select web_price_cents, pos_price_cents from catalog_products where id = ${croissant}`.execute(
      db,
    );
    expect(cat.rows[0]).toEqual({ web_price_cents: 2800, pos_price_cents: 3000 });
    // Terminarla libera el periodo: la siguiente ya no solapa.
    await asStaff("end_promotion", [a]);
    expect(await priceOf(croissant, "pos")).toBe(4500);
    const c = await asStaff<string>("create_promotion", [
      croissant,
      "all",
      3500,
      new Date().toISOString(),
      null,
      "C",
    ]);
    expect(c).toBeTruthy();
    expect(await priceOf(croissant, "pos")).toBe(3500);
    // Futura consecutiva (empieza cuando termina otra): permitida
    const futureFrom = new Date(Date.now() + 864e5 * 10).toISOString();
    await asStaff("end_promotion", [c]);
    const d = await asStaff<string>("create_promotion", [
      croissant,
      "all",
      3000,
      new Date().toISOString(),
      futureFrom,
      "D",
    ]);
    const e = await asStaff<string>("create_promotion", [
      croissant,
      "all",
      3200,
      futureFrom,
      null,
      "E",
    ]);
    expect(d && e).toBeTruthy();
  });

  it("set_regular_price no reescribe el histórico y los precios cerrados conservan su valor", async () => {
    await asStaff("set_regular_price", [croissant, "all", 4800, "ajuste"]);
    await asStaff("set_regular_price", [croissant, "all", 5000, "ajuste 2"]);
    const rows = await sql<{ price_cents: number; closed: boolean }>`
      select price_cents, valid_to is not null as closed from product_prices
      where product_id = ${croissant} and kind = 'regular' order by valid_from`.execute(db);
    expect(rows.rows).toEqual([
      { price_cents: 4500, closed: true },
      { price_cents: 4800, closed: true },
      { price_cents: 5000, closed: false },
    ]);
    await expect(asStaff("set_regular_price", [croissant, "all", -1, null])).rejects.toThrow(
      /mayor o igual a cero/,
    );
    const deleted = await createProduct(db, "Borrado", 100);
    await sql`update products set deleted_at = now() where id = ${deleted}`.execute(db);
    await expect(asStaff("set_regular_price", [deleted, "all", 100, null])).rejects.toThrow(
      /no encontrado/,
    );
  });
});

// ── Recetas / costos ────────────────────────────────────────────────────────
describe("upsert_recipe: validaciones legibles y paridad de costos", () => {
  it("ingrediente repetido, eliminado, sin cantidad o con cantidad cero", async () => {
    const items = (x: unknown) => JSON.stringify(x);
    await expect(
      asStaff("upsert_recipe", [
        croissant,
        10,
        null,
        0,
        0,
        null,
        items([
          { ingredient_id: harina, qty: 500 },
          { ingredient_id: harina, qty: 5 },
        ]),
      ]),
    ).rejects.toThrow(/aparece dos veces/);
    await expect(
      asStaff("upsert_recipe", [
        croissant,
        10,
        null,
        0,
        0,
        null,
        items([{ ingredient_id: harina }]),
      ]),
    ).rejects.toThrow(/mayor a cero/);
    await expect(
      asStaff("upsert_recipe", [
        croissant,
        10,
        null,
        0,
        0,
        null,
        items([{ ingredient_id: harina, qty: 0 }]),
      ]),
    ).rejects.toThrow(/mayor a cero/);
    await expect(
      asStaff("upsert_recipe", [
        croissant,
        10,
        null,
        0,
        0,
        null,
        items([{ ingredient_id: "00000000-0000-4000-8000-000000000000", qty: 1 }]),
      ]),
    ).rejects.toThrow(/ya no existe/);
    await expect(
      asStaff("upsert_recipe", [croissant, 10, null, -1, 0, null, items([])]),
    ).rejects.toThrow(/mano de obra/);
    await expect(
      asStaff("upsert_recipe", [croissant, 0, null, 0, 0, null, items([])]),
    ).rejects.toThrow(/rendimiento/);
    // Nada de lo anterior dejó receta a medias
    const n = await sql<{ n: number }>`select count(*)::int n from recipes`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
    // Caso feliz: 500 g × 0.022 = 11 MXN / 10 = 110 centavos
    await asStaff("upsert_recipe", [
      croissant,
      10,
      "charola",
      0,
      0,
      null,
      items([{ ingredient_id: harina, qty: 500, note: " tamizada " }]),
    ]);
    const cost = await callFn<number>(db, "product_cost_cents", [croissant]);
    expect(cost).toBe(110);
    const note = await sql<{ note: string }>`select note from recipe_items`.execute(db);
    expect(note.rows[0]!.note).toBe("tamizada");
  });

  it("product_cost_impact anticipa exactamente el costo que product_cost_cents da tras registrar el precio", async () => {
    const mantequilla = await createIngredient("Mantequilla", "g", 1808, 40000);
    await asStaff("upsert_recipe", [
      croissant,
      12,
      null,
      1500,
      300,
      null,
      JSON.stringify([
        { ingredient_id: harina, qty: 1000 },
        { ingredient_id: mantequilla, qty: 500 },
      ]),
    ]);
    await sql`update costing_settings set default_waste_bps = 250, overhead_mode = 'pct_of_ingredients', overhead_pct_bps = 1200 where id = 1`.execute(
      db,
    );
    // Nuevo precio de mantequilla: $455.99 por 1.808 kg
    const newUnitCost = 45599 / 100 / 1808;
    const impact = await sql<{
      product_id: string;
      current_cost_cents: number;
      new_cost_cents: number;
    }>`select product_id, current_cost_cents, new_cost_cents from product_cost_impact(${mantequilla}, ${newUnitCost})`.execute(
      db,
    );
    const before = await callFn<number>(db, "product_cost_cents", [croissant]);
    expect(impact.rows[0]!.current_cost_cents).toBe(before);
    await asStaff("record_ingredient_price", [
      mantequilla,
      1808,
      45599,
      "Caja 1.808 kg",
      null,
      false,
      1,
    ]);
    const after = await callFn<number>(db, "product_cost_cents", [croissant]);
    expect(after).toBe(impact.rows[0]!.new_cost_cents);
    // El historial es inmutable: el precio anterior sigue ahí y el nuevo es el vigente
    const hist = await sql<{
      price_cents: number;
    }>`select price_cents from ingredient_prices where ingredient_id = ${mantequilla} order by valid_from`.execute(
      db,
    );
    expect(hist.rows.map((r) => r.price_cents)).toEqual([40000, 45599]);
    // Precio 0 y contenido 0
    await asStaff("record_ingredient_price", [mantequilla, 100, 0, null, null, false, 1]);
    expect(await callFn<number>(db, "product_cost_cents", [croissant])).toBeLessThan(after);
    await expect(
      asStaff("record_ingredient_price", [mantequilla, 0, 100, null, null, false, 1]),
    ).rejects.toThrow(/contenido/);
    // El desglose y la vista usan la misma fórmula
    const b = await callFn<{ cost_per_piece_cents: number; suggested_price_cents: number }>(
      db,
      "recipe_formula_breakdown",
      [croissant],
    );
    const v = await sql<{
      cost_per_piece_cents: number;
      suggested_price_cents: number;
    }>`select cost_per_piece_cents, suggested_price_cents from recipe_costing where product_id = ${croissant}`.execute(
      db,
    );
    expect(v.rows[0]).toEqual({
      cost_per_piece_cents: b.cost_per_piece_cents,
      suggested_price_cents: b.suggested_price_cents,
    });
  });
});

// ── Cupones ─────────────────────────────────────────────────────────────────
describe("validate_coupon: matriz de reglas", () => {
  async function coupon(extra: Record<string, unknown> = {}) {
    const cols = {
      code: "PROMO10",
      kind: "pct",
      value_bps: 1000,
      value_cents: null,
      product_id: null,
      min_subtotal_cents: 0,
      starts_at: null,
      ends_at: null,
      max_uses: null,
      max_uses_per_customer: 1,
      channels: ["all"],
      segment: {},
      is_active: true,
      ...extra,
    } as Record<string, unknown>;
    const r = await sql<{
      id: string;
    }>`insert into coupons(code, kind, value_bps, value_cents, product_id, min_subtotal_cents, starts_at, ends_at, max_uses, max_uses_per_customer, channels, segment, is_active)
      values (${cols.code as string}, ${cols.kind as string}::coupon_kind, ${cols.value_bps as number | null}, ${cols.value_cents as number | null}, ${cols.product_id as string | null},
              ${cols.min_subtotal_cents as number}, ${cols.starts_at as string | null}, ${cols.ends_at as string | null}, ${cols.max_uses as number | null}, ${cols.max_uses_per_customer as number},
              ${cols.channels as string[]}::price_channel[], ${JSON.stringify(cols.segment)}::jsonb, ${cols.is_active as boolean}) returning id`.execute(
      db,
    );
    return r.rows[0]!.id;
  }
  const validate = async (
    code: string,
    customer: string | null,
    subtotal: number,
    channel: "pos" | "web",
    items: unknown[] = [],
  ) =>
    callFn<{ valid: boolean; reason?: string; discount_cents?: number }>(db, "validate_coupon", [
      code,
      customer,
      subtotal,
      channel,
      JSON.stringify(items),
    ]);

  it("código con espacios/minúsculas, mínimo, canal, vigencia, agotado, por cliente, segmentos y producto", async () => {
    await coupon({ min_subtotal_cents: 5000, channels: ["pos"] });
    expect(await validate(" promo10 ", null, 10000, "pos")).toMatchObject({
      valid: true,
      discount_cents: 1000,
    });
    expect(await validate("PROMO10", null, 4999, "pos")).toMatchObject({
      valid: false,
      reason: "min_subtotal",
    });
    expect(await validate("PROMO10", null, 10000, "web")).toMatchObject({ reason: "channel" });
    expect(await validate("NOPE", null, 10000, "pos")).toMatchObject({ reason: "not_found" });
    expect(await validate("", null, 10000, "pos")).toMatchObject({ reason: "empty" });
    await coupon({ code: "FUTURO", starts_at: sql`now() + interval '1 day'` });
    expect(await validate("FUTURO", null, 10000, "pos")).toMatchObject({ reason: "not_started" });
    await coupon({ code: "VENCIDO", ends_at: sql`now() - interval '1 second'` });
    expect(await validate("VENCIDO", null, 10000, "pos")).toMatchObject({ reason: "expired" });
    await coupon({ code: "AGOTADO", max_uses: 1 });
    await sql`update coupons set uses_count = 1 where code = 'AGOTADO'`.execute(db);
    expect(await validate("AGOTADO", null, 10000, "pos")).toMatchObject({ reason: "exhausted" });
    await coupon({ code: "OFF", is_active: false });
    expect(await validate("OFF", null, 10000, "pos")).toMatchObject({ reason: "inactive" });
    // Segmentos
    const { customer_id: vipless } = await createCustomer(db, "Sin nivel", "6641110000");
    await coupon({ code: "SOLOVIP", segment: { tiers: ["vip"] } });
    expect(await validate("SOLOVIP", null, 10000, "pos")).toMatchObject({
      reason: "requires_customer",
    });
    expect(await validate("SOLOVIP", vipless, 10000, "pos")).toMatchObject({ reason: "segment" });
    await sql`update customers set tier_key = 'vip' where id = ${vipless}`.execute(db);
    expect(await validate("SOLOVIP", vipless, 10000, "pos")).toMatchObject({ valid: true });
    // Límite por cliente
    const cId = await coupon({ code: "UNAVEZ", max_uses_per_customer: 1 });
    await sql`insert into coupon_redemptions(coupon_id, customer_id, discount_cents) values (${cId}, ${vipless}, 100)`.execute(
      db,
    );
    expect(await validate("UNAVEZ", vipless, 10000, "pos")).toMatchObject({
      reason: "customer_limit",
    });
    // Producto gratis: requiere el producto en el carrito; descuento = precio unitario más bajo
    await coupon({ code: "GRATIS", kind: "free_product", value_bps: null, product_id: galleta });
    expect(await validate("GRATIS", null, 10000, "pos", [])).toMatchObject({
      reason: "product_not_in_cart",
    });
    expect(
      await validate("GRATIS", null, 10000, "pos", [
        { product_id: galleta, qty: 2, unit_price_cents: 2500, total_cents: 5000 },
      ]),
    ).toMatchObject({ valid: true, discount_cents: 2500 });
    // % restringido a un producto y monto que nunca supera el subtotal
    await coupon({ code: "GAL50", value_bps: 5000, product_id: galleta });
    expect(
      await validate("GAL50", null, 7000, "pos", [
        { product_id: galleta, qty: 1, unit_price_cents: 2500, total_cents: 2500 },
        { product_id: croissant, qty: 1, unit_price_cents: 4500, total_cents: 4500 },
      ]),
    ).toMatchObject({ valid: true, discount_cents: 1250 });
    await coupon({ code: "MENOS", kind: "amount", value_bps: null, value_cents: 99999 });
    expect(await validate("MENOS", null, 3000, "pos")).toMatchObject({
      valid: true,
      discount_cents: 3000,
    });
  });

  it("nuevos clientes: válido antes de la primera venta e inválido después; el código es único (citext)", async () => {
    await coupon({ code: "BIENVENIDA", segment: { new_customers_only: true } });
    const { customer_id: c } = await createCustomer(db, "Nuevo", "6642220000");
    expect(await validate("BIENVENIDA", c, 10000, "pos")).toMatchObject({ valid: true });
    await posCheckout(db, staff, {
      customer_id: c,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    expect(await validate("BIENVENIDA", c, 10000, "pos")).toMatchObject({ reason: "segment" });
    await expect(coupon({ code: "bienvenida" })).rejects.toMatchObject({ code: "23505" });
  });
});

// ── Fidelización en la venta ────────────────────────────────────────────────
describe("pos_checkout: puntos por monto + bonos por producto + cumpleaños", () => {
  it("bonos activos suman por unidad; inactivos no; cumpleaños multiplica solo la parte por monto", async () => {
    const { customer_id: c } = await createCustomer(db, "Puntos", "6643330000");
    await sql`insert into loyalty_product_bonuses(product_id, bonus_points, is_active) values (${croissant}, 5, true), (${galleta}, 50, false)`.execute(
      db,
    );
    // 2 croissants (9000) + 1 galleta (2500) = 11500 → floor(11.5) = 11 + 2×5 = 21
    const r = await posCheckout(db, staff, {
      customer_id: c,
      items: [
        { product_id: croissant, qty: 2 },
        { product_id: galleta, qty: 1 },
      ],
      payments: [{ provider: "cash", method: "cash", amount_cents: 11500 }],
    });
    expect(r.points_earned).toBe(21);
    expect((await customerRow(c)).points_balance).toBe(21);
    // Cumpleaños hoy (zona del negocio): (11 × 2) + 10 = 32
    await sql`update customers set birthday = ((now() at time zone (select timezone from business_settings where id = 1))::date - interval '30 years')::date where id = ${c}`.execute(
      db,
    );
    const r2 = await posCheckout(db, staff, {
      customer_id: c,
      items: [
        { product_id: croissant, qty: 2 },
        { product_id: galleta, qty: 1 },
      ],
      payments: [{ provider: "cash", method: "cash", amount_cents: 11500 }],
    });
    expect(r2.points_earned).toBe(32);
    // Mínimo de compra y redondeo 'round'
    await sql`update loyalty_program set min_purchase_cents = 5000, rounding = 'round'`.execute(db);
    await sql`update customers set birthday = null where id = ${c}`.execute(db);
    const r3 = await posCheckout(db, staff, {
      customer_id: c,
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
    });
    expect(r3.points_earned).toBe(0); // bajo el mínimo: ni siquiera el bono
    const r4 = await posCheckout(db, staff, {
      customer_id: c,
      items: [{ product_id: galleta, qty: 3 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 7500 }],
    });
    expect(r4.points_earned).toBe(8); // round(7.5) = 8
    // Programa apagado → 0
    await sql`update feature_flags set enabled = false where key = 'loyalty'`.execute(db);
    const r5 = await posCheckout(db, staff, {
      customer_id: c,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    expect(r5.points_earned).toBe(0);
  });
});

// ── Fusión de clientes ──────────────────────────────────────────────────────
describe("merge_customers en ambos sentidos", () => {
  it("pedidos, puntos e historial migran; el fusionado queda marcado; no se fusiona consigo mismo ni dos veces", async () => {
    const { customer_id: a } = await createCustomer(db, "Ana", "6644440000");
    const { customer_id: b } = await createCustomer(db, "Ana Duplicada", "6644440001");
    await posCheckout(db, staff, {
      customer_id: b,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    await asStaff("loyalty_post", [a, "earn", 7, null, null, "x"]);
    await expect(asStaff("merge_customers", [a, a])).rejects.toThrow(/consigo mismo/);
    const res = await asStaff<{ orders: number; points_transferred: number }>("merge_customers", [
      a,
      b,
    ]);
    expect(res).toMatchObject({ orders: 1, points_transferred: 4 });
    const keep = await customerRow(a);
    expect(keep).toMatchObject({ points_balance: 11, lifetime_points: 11, total_orders: 1 });
    const merged = await sql<{
      merged_into_id: string | null;
      points_balance: number;
    }>`select merged_into_id, points_balance from customers where id = ${b}`.execute(db);
    expect(merged.rows[0]).toEqual({ merged_into_id: a, points_balance: 0 });
    const ledger = await sql<{ n: number }>`select count(*)::int n from loyalty_transactions
      where customer_id = ${a} or customer_id in (select id from customers where merged_into_id = ${a})`.execute(
      db,
    );
    expect(ledger.rows[0]!.n).toBe(4); // earn b, earn a, adjust −4 (b), adjust +4 (a)
    await expect(asStaff("merge_customers", [b, a])).rejects.toThrow(
      /ya fue eliminado o fusionado/,
    );
    await expect(asStaff("merge_customers", [a, b])).rejects.toThrow(/ya fue fusionado/);
    // Sentido contrario con otro par: conservar al que tiene compras
    const { customer_id: c } = await createCustomer(db, "Carlos", "6645550000");
    const { customer_id: d } = await createCustomer(db, "Carlos Dup", "6645550001");
    await asStaff("loyalty_post", [c, "earn", 3, null, null, "x"]);
    await asStaff("merge_customers", [d, c]);
    expect(await customerRow(d)).toMatchObject({ points_balance: 3, lifetime_points: 3 });
    // Los duplicados sugeridos ya no listan al fusionado
    const dups = await sql<{
      n: number;
    }>`select count(*)::int n from customer_duplicates(${a})`.execute(db);
    expect(dups.rows[0]!.n).toBe(0);
  });
});

// ── Reportes: cortes en la zona del negocio ─────────────────────────────────
describe("report_summary / report_daily_series respetan la zona del negocio", () => {
  it("una venta a las 23:30 del 31/dic cuenta en diciembre; la anulada no cuenta; el reembolso resta", async () => {
    const tzRow = await sql<{
      tz: string;
    }>`select timezone tz from business_settings where id = 1`.execute(db);
    const tz = tzRow.rows[0]!.tz;
    const s1 = await posCheckout(db, staff, {
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    const s2 = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
    });
    const s3 = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 5000 }],
    });
    await sql`update sales set sold_at = ('2025-12-31 23:30'::timestamp at time zone ${tz}) where id = ${s1.sale_id as string}`.execute(
      db,
    );
    await sql`update sales set sold_at = ('2026-01-01 00:10'::timestamp at time zone ${tz}) where id = ${s2.sale_id as string}`.execute(
      db,
    );
    await sql`update sales set sold_at = ('2025-12-31 12:00'::timestamp at time zone ${tz}) where id = ${s3.sale_id as string}`.execute(
      db,
    );
    await asStaff("void_sale", [s3.sale_id, "prueba"]);
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${s1.order_id as string}`.execute(db);
    await asStaff("record_refund", [
      JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: 500, reason: "parcial" }),
    ]);
    await sql`update refunds set created_at = ('2025-12-31 23:45'::timestamp at time zone ${tz})`.execute(
      db,
    );
    const dec = await callFn<{
      sales: { count: number; gross_cents: number };
      refunds_cents: number;
      net_cents: number;
    }>(db, "report_summary", ["2025-12-01", "2025-12-31"]);
    expect(dec.sales.count).toBe(1);
    expect(dec.sales.gross_cents).toBe(4500);
    expect(dec.refunds_cents).toBe(500);
    expect(dec.net_cents).toBe(4000);
    const jan = await callFn<{ sales: { count: number; gross_cents: number } }>(
      db,
      "report_summary",
      ["2026-01-01", "2026-01-01"],
    );
    expect(jan.sales).toMatchObject({ count: 1, gross_cents: 2500 });
    const series = await sql<{ day: string; revenue_cents: number; refunds_cents: number }>`
      select day::text as day, revenue_cents, refunds_cents from report_daily_series('2025-12-31', '2026-01-01')`.execute(
      db,
    );
    expect(series.rows).toEqual([
      { day: "2025-12-31", revenue_cents: 4500, refunds_cents: 500 },
      { day: "2026-01-01", revenue_cents: 2500, refunds_cents: 0 },
    ]);
    // Rango vacío y un solo día sin datos
    const empty = await callFn<{ sales: { count: number }; net_cents: number }>(
      db,
      "report_summary",
      ["2020-01-01", "2020-01-01"],
    );
    expect(empty.sales.count).toBe(0);
    expect(empty.net_cents).toBe(0);
    // Totales cruzados con SQL directo
    const direct = await sql<{ gross: number }>`
      with rr as (select * from report_range('2025-12-01', '2025-12-31'))
      select coalesce(sum(total_cents), 0)::bigint gross from sales, rr
      where voided_at is null and sold_at >= rr.v_from and sold_at < rr.v_to`.execute(db);
    expect(direct.rows[0]!.gross).toBe(dec.sales.gross_cents);
  });
});
