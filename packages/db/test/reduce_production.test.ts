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

/**
 * `reduce_production` (0032): restar producción del día.
 * Opera por CANTIDAD sobre los lotes de hoy (del más nuevo al más viejo), nunca deja producción
 * negativa y devuelve los insumos en proporción, igual que `undo_production` pero sin ventana de tiempo.
 */
const { db, pool } = testDb();
let staff: string;
let product: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  product = await createProduct(db, "Concha de vainilla", 2500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

type Reduced = { produced_today: number; on_hand: number; batches_affected: number };

function produce(qty: number, at?: string, consume: boolean | null = null) {
  return withStaff(db, staff, (trx) =>
    callFn<string>(trx, "record_production", [product, qty, null, consume, at ?? null]),
  );
}

function reduce(qty: number, note?: string) {
  return withStaff(db, staff, (trx) =>
    callFn<Reduced>(trx, "reduce_production", [product, qty, note ?? null]),
  );
}

/** "Producido hoy" tal como lo calcula el tablero: lotes del día local, sin deshacer. */
async function producedToday() {
  const r = await sql<{ n: string }>`
    select coalesce(sum(b.qty), 0)::text as n from production_batches b
     where b.product_id = ${product} and b.undone_at is null
       and (b.produced_at at time zone (select timezone from business_settings where id = 1))::date
           = (now() at time zone (select timezone from business_settings where id = 1))::date`.execute(
    db,
  );
  return Number(r.rows[0]!.n);
}

async function batches() {
  const r = await sql<{ id: string; qty: string; undone_at: Date | null; lot_code: string }>`
    select id, qty::text, undone_at, lot_code from production_batches
     where product_id = ${product} order by produced_at, created_at`.execute(db);
  return r.rows;
}

describe("restar producción (reduce_production)", () => {
  it("resta simple: baja producido hoy y stock, y deja el lote parcial abierto", async () => {
    await produce(10);
    const r = await reduce(3);
    expect(r).toMatchObject({ produced_today: 7, on_hand: 7, batches_affected: 1 });
    expect(await producedToday()).toBe(7);
    expect(await onHand(db, product)).toBe(7);
    const [b] = await batches();
    expect(Number(b!.qty)).toBe(7);
    expect(b!.undone_at).toBeNull();
  });

  it("registra un CORRECTION negativo por lote con referencia al lote y al staff", async () => {
    const batch = await produce(10);
    await reduce(4, "se quemaron");
    const m = await sql<{
      type: string;
      qty: string;
      ref_type: string;
      ref_id: string;
      reason: string;
      note: string;
      staff_id: string;
    }>`select type, qty::text, ref_type, ref_id, reason, note, staff_id from inventory_movements
       where type = 'CORRECTION'`.execute(db);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({
      type: "CORRECTION",
      ref_type: "production_batch",
      ref_id: batch,
      reason: "reduce",
      note: "se quemaron",
      staff_id: staff,
    });
    expect(Number(m.rows[0]!.qty)).toBe(-4);
  });

  it("resta parcial de un lote: reduce qty sin marcarlo deshecho", async () => {
    await produce(12);
    await reduce(5);
    const [b] = await batches();
    expect(Number(b!.qty)).toBe(7);
    expect(b!.undone_at).toBeNull();
    await reduce(7);
    const [b2] = await batches();
    expect(Number(b2!.qty)).toBe(7); // el lote conserva su cantidad al quedar deshecho completo
    expect(b2!.undone_at).not.toBeNull();
    expect(await producedToday()).toBe(0);
    expect(await onHand(db, product)).toBe(0);
  });

  it("abarca varios lotes del más nuevo al más viejo", async () => {
    // Segundos, no horas: con horas, una corrida de madrugada dejaba el lote más viejo en el día local
    // ANTERIOR (reduce_production solo toca los de hoy) y la prueba fallaba según la hora del reloj.
    const now = Date.now();
    await produce(5, new Date(now - 3_000).toISOString());
    await produce(4, new Date(now - 2_000).toISOString());
    await produce(3, new Date(now - 1_000).toISOString());
    const r = await reduce(8);
    expect(r).toMatchObject({ produced_today: 4, on_hand: 4, batches_affected: 3 });
    const rows = await batches();
    expect(Number(rows[0]!.qty)).toBe(4); // el más viejo (5) quedó en 4
    expect(rows[0]!.undone_at).toBeNull();
    expect(rows[1]!.undone_at).not.toBeNull(); // el de 4 se deshizo completo
    expect(rows[2]!.undone_at).not.toBeNull(); // el de 3 se deshizo completo
    const mv = await sql<{ n: string }>`
      select count(*)::text as n from inventory_movements where type = 'CORRECTION'`.execute(db);
    expect(Number(mv.rows[0]!.n)).toBe(3);
  });

  it("falla si la cantidad supera lo producido hoy y no toca nada", async () => {
    await produce(6);
    await expect(reduce(7)).rejects.toThrow(/solo se han producido/i);
    expect(await producedToday()).toBe(6);
    expect(await onHand(db, product)).toBe(6);
    const mv = await sql<{ n: string }>`
      select count(*)::text as n from inventory_movements where type = 'CORRECTION'`.execute(db);
    expect(Number(mv.rows[0]!.n)).toBe(0);
  });

  it("rechaza cantidades inválidas y productos inexistentes", async () => {
    await produce(5);
    await expect(reduce(0)).rejects.toThrow(/Cantidad inválida/);
    await expect(reduce(-2)).rejects.toThrow(/Cantidad inválida/);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "reduce_production", ["00000000-0000-0000-0000-000000000000", 1, null]),
      ),
    ).rejects.toThrow(/Producto no existe/);
  });

  it("no toca los lotes de días anteriores", async () => {
    const tz = (
      await sql<{ tz: string }>`select timezone as tz from business_settings where id = 1`.execute(
        db,
      )
    ).rows[0]!.tz;
    // Mediodía local de ayer: no puede caer en el día de hoy en ninguna zona horaria.
    const ayer = (
      await sql<{ t: string }>`
        select (((now() at time zone ${tz})::date - 1) + time '12:00') at time zone ${tz} as t`.execute(
        db,
      )
    ).rows[0]!.t;
    await produce(10, new Date(ayer).toISOString());
    await produce(4);
    expect(await producedToday()).toBe(4);
    expect(await onHand(db, product)).toBe(14);

    const r = await reduce(4);
    expect(r).toMatchObject({ produced_today: 0, on_hand: 10, batches_affected: 1 });
    await expect(reduce(1)).rejects.toThrow(/solo se han producido/i);

    const rows = await batches();
    expect(Number(rows[0]!.qty)).toBe(10); // el lote de ayer intacto
    expect(rows[0]!.undone_at).toBeNull();
    expect(rows[1]!.undone_at).not.toBeNull();
  });

  it("devuelve los insumos en proporción cuando el lote los consumió", async () => {
    const ing = (
      await sql<{ id: string }>`
        insert into ingredients(name, base_unit, stock_qty) values ('Harina', 'g', 5000) returning id`.execute(
        db,
      )
    ).rows[0]!.id;
    const recipe = (
      await sql<{
        id: string;
      }>`insert into recipes(product_id, yield_qty) values (${product}, 10) returning id`.execute(
        db,
      )
    ).rows[0]!.id;
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${recipe}, ${ing}, 500)`.execute(
      db,
    );
    const stock = async () =>
      Number(
        (
          await sql<{
            stock_qty: string;
          }>`select stock_qty::text from ingredients where id = ${ing}`.execute(db)
        ).rows[0]!.stock_qty,
      );

    await produce(20, undefined, true); // 20 pzas → 1000 g
    expect(await stock()).toBe(4000);

    await reduce(5); // 5/20 del lote → devuelve 250 g
    expect(await stock()).toBe(4250);
    expect(await onHand(db, product)).toBe(15);

    await reduce(15); // el resto del lote → devuelve los 750 g que quedaban
    expect(await stock()).toBe(5000);
    expect(await onHand(db, product)).toBe(0);
    expect(await producedToday()).toBe(0);
  });

  it("emite PRODUCTION_REDUCED con los lotes afectados", async () => {
    await produce(6);
    await reduce(2);
    const ev = await sql<{ payload: { qty: number; batches_affected: number } }>`
      select payload from domain_events where event_type = 'PRODUCTION_REDUCED'`.execute(db);
    expect(ev.rows).toHaveLength(1);
    expect(Number(ev.rows[0]!.payload.qty)).toBe(2);
    expect(Number(ev.rows[0]!.payload.batches_affected)).toBe(1);
  });
});
