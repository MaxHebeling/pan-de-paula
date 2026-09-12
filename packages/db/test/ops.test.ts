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
  product = await createProduct(db, "Concha de vainilla", 2500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

async function produce(qty: number) {
  return withStaff(db, staff, (trx) =>
    callFn<string>(trx, "record_production", [product, qty, null, null]),
  );
}

describe("deshacer producción", () => {
  it("revierte el lote con un CORRECTION negativo que referencia al lote", async () => {
    await produce(10);
    const batch = await produce(5);
    expect(await onHand(db, product)).toBe(15);
    const mv = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "undo_production", [batch, "deshacer"]),
    );
    expect(mv).toBeGreaterThan(0);
    expect(await onHand(db, product)).toBe(10);
    const m = await sql<{
      type: string;
      qty: string;
      ref_type: string;
      ref_id: string;
      reason: string;
      note: string;
    }>`select type, qty, ref_type, ref_id, reason, note from inventory_movements where id = ${mv}`.execute(
      db,
    );
    expect(m.rows[0]).toMatchObject({
      type: "CORRECTION",
      ref_type: "production_batch",
      ref_id: batch,
      reason: "undo",
      note: "deshacer",
    });
    expect(Number(m.rows[0]!.qty)).toBe(-5);
    const b = await sql<{
      undone_at: Date | null;
    }>`select undone_at from production_batches where id = ${batch}`.execute(db);
    expect(b.rows[0]!.undone_at).not.toBeNull();
    const ev = await sql<{
      n: number;
    }>`select count(*)::int as n from domain_events where event_type = 'PRODUCTION_UNDONE'`.execute(
      db,
    );
    expect(ev.rows[0]!.n).toBe(1);
  });

  it("no se puede deshacer dos veces ni fuera de la ventana de 2 minutos", async () => {
    const batch = await produce(8);
    await withStaff(db, staff, (trx) => callFn(trx, "undo_production", [batch, "deshacer"]));
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "undo_production", [batch, "deshacer"])),
    ).rejects.toThrow(/ya fue deshecho/);
    expect(await onHand(db, product)).toBe(0);

    const old = await produce(3);
    await sql`update production_batches set created_at = now() - interval '3 minutes' where id = ${old}`.execute(
      db,
    );
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "undo_production", [old, "deshacer"])),
    ).rejects.toThrow(/2 minutos/);
    expect(await onHand(db, product)).toBe(3);
  });

  it("devuelve los insumos consumidos cuando el lote descontó ingredientes", async () => {
    const ing = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit, stock_qty) values ('Harina', 'g', 5000) returning id`.execute(
      db,
    );
    const rec = await sql<{
      id: string;
    }>`insert into recipes(product_id, yield_qty) values (${product}, 10) returning id`.execute(db);
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}, ${ing.rows[0]!.id}, 500)`.execute(
      db,
    );
    const batch = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "record_production", [product, 20, null, true]),
    );
    let stock = await sql<{
      stock_qty: string;
    }>`select stock_qty from ingredients where id = ${ing.rows[0]!.id}`.execute(db);
    expect(Number(stock.rows[0]!.stock_qty)).toBe(4000);
    await withStaff(db, staff, (trx) => callFn(trx, "undo_production", [batch, "deshacer"]));
    stock = await sql<{
      stock_qty: string;
    }>`select stock_qty from ingredients where id = ${ing.rows[0]!.id}`.execute(db);
    expect(Number(stock.rows[0]!.stock_qty)).toBe(5000);
    expect(await onHand(db, product)).toBe(0);
  });
});

describe("corrección manual de stock", () => {
  it("suma o resta con motivo acotado y cierra alertas si se repuso", async () => {
    await sql`insert into notifications(kind, severity, title, entity, entity_id) values ('out_of_stock', 'warning', 'Agotado', 'product', ${product})`.execute(
      db,
    );
    const id = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "record_stock_correction", [product, 12, "difference", "conteo rápido"]),
    );
    expect(id).toBeGreaterThan(0);
    expect(await onHand(db, product)).toBe(12);
    const open = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where entity_id = ${product} and read_at is null`.execute(
      db,
    );
    expect(open.rows[0]!.n).toBe(0);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_stock_correction", [product, -2, "error", null]),
    );
    expect(await onHand(db, product)).toBe(10);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_stock_correction", [product, 0, "difference", null]),
      ),
    ).rejects.toThrow(/cero/);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_stock_correction", [product, 1, "burnt", null]),
      ),
    ).rejects.toThrow(/inválido/);
  });
});

describe("wizard de conteo físico", () => {
  it("crea con esperado precargado, captura, aplica y no permite dos abiertos", async () => {
    const other = await createProduct(db, "Brownie", 4000);
    await sql`insert into products(name, slug, track_stock) values ('Servicio', 'servicio-x', false)`.execute(
      db,
    );
    await produce(10);
    const count = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_stock_count", ["conteo de cierre"]),
    );
    const items = await sql<{
      product_id: string;
      expected_qty: string;
      counted_qty: string;
    }>`select product_id, expected_qty, counted_qty from stock_count_items where stock_count_id = ${count} order by expected_qty desc`.execute(
      db,
    );
    expect(items.rows.length).toBe(2); // solo productos con control de stock
    expect(items.rows[0]).toMatchObject({ product_id: product });
    expect(Number(items.rows[0]!.expected_qty)).toBe(10);
    expect(Number(items.rows[0]!.counted_qty)).toBe(10);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "create_stock_count", [null])),
    ).rejects.toThrow(/abierto/);

    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_stock_count_item", [count, product, 7, "faltan 3"]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_stock_count_item", [count, other, 2, null]),
    );
    const n = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [count]),
    );
    expect(n).toBe(2);
    expect(await onHand(db, product)).toBe(7);
    expect(await onHand(db, other)).toBe(2);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "set_stock_count_item", [count, product, 1, null])),
    ).rejects.toThrow(/cerrado/);
  });

  it("descartar no toca inventario", async () => {
    await produce(10);
    const count = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_stock_count", [null]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_stock_count_item", [count, product, 0, null]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "discard_stock_count", [count]));
    expect(await onHand(db, product)).toBe(10);
    const sc = await sql<{
      status: string;
    }>`select status from stock_counts where id = ${count}`.execute(db);
    expect(sc.rows[0]!.status).toBe("discarded");
    const again = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [count]),
    );
    expect(again).toBe(0);
    expect(await onHand(db, product)).toBe(10);
  });
});

describe("alertas de stock (cron)", () => {
  it("crea alertas de bajo/agotado e insumos sin duplicar y las cierra al reponer", async () => {
    const other = await createProduct(db, "Galleta", 2500);
    await produce(3); // bajo (umbral 5); "other" queda en 0 = agotado
    await sql`insert into ingredients(name, base_unit, stock_qty, min_stock_qty) values ('Mantequilla', 'g', 100, 500)`.execute(
      db,
    );
    const first = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(first).toMatchObject({ low_stock: 1, out_of_stock: 1, ingredient_low: 1 });
    const second = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(second).toMatchObject({ low_stock: 0, out_of_stock: 0, ingredient_low: 0, closed: 0 });
    const open = await sql<{
      kind: string;
      entity_id: string;
    }>`select kind, entity_id from notifications where read_at is null order by kind`.execute(db);
    expect(open.rows.length).toBe(3);
    expect(open.rows.map((r) => r.kind).sort()).toEqual([
      "ingredient_low",
      "low_stock",
      "out_of_stock",
    ]);

    // Reponer: producción cierra la de "bajo" (record_production) y el cron cierra la de "agotado"
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [other, 20, null, null]));
    await sql`update ingredients set stock_qty = 1000`.execute(db);
    const third = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(third.closed).toBe(1); // la de "agotado" ya la cerró record_production; el cron cierra la del insumo
    const stillOpen = await sql<{
      kind: string;
    }>`select kind from notifications where read_at is null`.execute(db);
    expect(stillOpen.rows.map((r) => r.kind)).toEqual(["low_stock"]);

    // De bajo a agotado: se sustituye la alerta
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_waste", [product, 3, "burnt", null, null]),
    );
    const fourth = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(fourth).toMatchObject({ out_of_stock: 1, upgraded: 1 });
    const final = await sql<{
      kind: string;
    }>`select kind from notifications where read_at is null and entity_id = ${product}`.execute(db);
    expect(final.rows.map((r) => r.kind)).toEqual(["out_of_stock"]);
  });

  it("job_runs bloquea ejecuciones concurrentes por lock_key", async () => {
    await sql`delete from job_runs`.execute(db);
    await sql`insert into job_runs(job_name, lock_key) values ('stock-alerts', 'stock-alerts')`.execute(
      db,
    );
    await expect(
      sql`insert into job_runs(job_name, lock_key) values ('stock-alerts', 'stock-alerts')`.execute(
        db,
      ),
    ).rejects.toThrow();
    await sql`update job_runs set status = 'succeeded', finished_at = now() where lock_key = 'stock-alerts'`.execute(
      db,
    );
    await sql`insert into job_runs(job_name, lock_key) values ('stock-alerts', 'stock-alerts')`.execute(
      db,
    );
    const n = await sql<{ n: number }>`select count(*)::int as n from job_runs`.execute(db);
    expect(n.rows[0]!.n).toBe(2);
  });
});
