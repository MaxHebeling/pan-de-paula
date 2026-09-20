import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  onHand,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

/**
 * Productos especiales o temporales (migración 0017).
 *
 * La prueba levanta el alta EXACTAMENTE como la hace el CRM (`especiales-actions.ts`): una fila de
 * `products` con `is_temporary`, el precio por `set_regular_price` y el stock inicial por
 * `record_stock_correction(..., 'initial', …)`. Lo que se verifica es que el especial no necesita
 * ninguna regla nueva: se vende, se descuenta, se desactiva y se reactiva como cualquier producto,
 * y su historial (ventas y precios pasados) nunca se reescribe.
 */
const { db, pool } = testDb();
let staff: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Alta de especial, igual que createSpecialProduct: producto + precio + stock inicial. */
async function altaEspecial(name: string, priceCents: number, stock = 0) {
  return withStaff(db, staff, async (trx) => {
    const r = await sql<{ id: string }>`
      insert into products(name, slug, is_temporary, is_active, show_on_web, show_on_pos,
                           track_stock, allow_preorder, requires_preorder, unit_label)
      values (${name}, ${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}, true, true, true, true, true, false, false, 'pieza')
      returning id`.execute(trx);
    const id = r.rows[0]!.id;
    await callFn(trx, "set_regular_price", [id, "all", priceCents, "Alta de producto especial"]);
    if (stock > 0)
      await callFn(trx, "record_stock_correction", [
        id,
        stock,
        "initial",
        "alta de producto especial",
      ]);
    return id;
  });
}

const precio = async (id: string, canal: "pos" | "web") =>
  (
    await sql<{
      p: number | null;
    }>`select current_price_cents(${id}, ${canal}::price_channel) as p`.execute(db)
  ).rows[0]!.p;

const flags = async (id: string) =>
  (
    await sql<{
      is_temporary: boolean;
      is_active: boolean;
      track_stock: boolean;
      allow_preorder: boolean;
    }>`select is_temporary, is_active, track_stock, allow_preorder from products where id = ${id}`.execute(
      db,
    )
  ).rows[0]!;

describe("products.is_temporary", () => {
  it("nace en false: los productos de siempre no se vuelven especiales", async () => {
    const pan = await createProduct(db, "Concha de vainilla", 2500);
    expect((await flags(pan)).is_temporary).toBe(false);
  });

  it("marca al especial sin cambiarle nada más y el índice parcial existe", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 12);
    expect(await flags(rosca)).toMatchObject({
      is_temporary: true,
      is_active: true,
      track_stock: true,
      allow_preorder: false,
    });
    const idx = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where tablename = 'products' and indexname = 'products_temporary_idx'`.execute(
      db,
    );
    expect(idx.rows[0]!.indexdef).toContain("WHERE (is_temporary AND (deleted_at IS NULL))");
  });

  it("la lista de especiales solo trae los marcados (activos e inactivos)", async () => {
    await createProduct(db, "Concha de vainilla", 2500);
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 5);
    const pan = await altaEspecial("Pan de muerto", 3500, 5);
    await sql`update products set is_active = false where id = ${pan}`.execute(db);
    const r = await sql<{ id: string; name: string; is_active: boolean }>`
      select id, name, is_active from products
      where is_temporary and deleted_at is null order by is_active desc, name`.execute(db);
    expect(r.rows.map((x) => x.id)).toEqual([rosca, pan]);
  });
});

describe("alta de un producto especial", () => {
  it("deja precio vigente en los dos canales y el stock inicial como movimiento INITIAL", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 12);
    expect(await precio(rosca, "pos")).toBe(45000);
    expect(await precio(rosca, "web")).toBe(45000);
    expect(await onHand(db, rosca)).toBe(12);

    const mv = await sql<{ type: string; qty: number; reason: string; note: string }>`
      select type, qty::float8 as qty, reason, note from inventory_movements where product_id = ${rosca}`.execute(
      db,
    );
    expect(mv.rows).toHaveLength(1);
    expect(mv.rows[0]).toMatchObject({
      type: "INITIAL",
      qty: 12,
      reason: "initial",
      note: "alta de producto especial",
    });
    // No se inventó un lote de producción para meter el stock.
    const lotes = await sql<{
      n: string;
    }>`select count(*)::text as n from production_batches`.execute(db);
    expect(lotes.rows[0]!.n).toBe("0");

    // El precio quedó en el historial normal, con su autor.
    const pp = await sql<{ kind: string; channel: string; label: string; created_by: string }>`
      select kind::text, channel::text, label, created_by::text from product_prices where product_id = ${rosca}`.execute(
      db,
    );
    expect(pp.rows).toHaveLength(1);
    expect(pp.rows[0]).toMatchObject({
      kind: "regular",
      channel: "all",
      label: "Alta de producto especial",
      created_by: staff,
    });
  });

  it("sin stock inicial no hay movimiento: nace en cero", async () => {
    const id = await altaEspecial("Panqué navideño", 18000);
    expect(await onHand(db, id)).toBe(0);
    const mv = await sql<{ n: string }>`
      select count(*)::text as n from inventory_movements where product_id = ${id}`.execute(db);
    expect(mv.rows[0]!.n).toBe("0");
  });
});

describe("edición: nombre, precio y stock", () => {
  it("cambiar el precio cierra la vigencia anterior y NO altera las ventas ya hechas", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 10);
    await posCheckout(db, staff, {
      items: [{ product_id: rosca, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 90000 }],
    });
    const antes = await sql<{ unit_price_cents: number; total_cents: number }>`
      select unit_price_cents, total_cents from order_items where product_id = ${rosca}`.execute(
      db,
    );
    expect(antes.rows).toEqual([{ unit_price_cents: 45000, total_cents: 90000 }]);

    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_regular_price", [rosca, "all", 52000, "Subió el precio"]),
    );
    expect(await precio(rosca, "pos")).toBe(52000);
    // La venta pasada conserva lo que se pagó.
    const despues = await sql<{ unit_price_cents: number; total_cents: number }>`
      select unit_price_cents, total_cents from order_items where product_id = ${rosca}`.execute(
      db,
    );
    expect(despues.rows).toEqual([{ unit_price_cents: 45000, total_cents: 90000 }]);
    // Y el precio viejo sigue en el historial, cerrado (no se editó ni se borró).
    const hist = await sql<{ price_cents: number; cerrado: boolean }>`
      select price_cents, (valid_to is not null) as cerrado from product_prices
      where product_id = ${rosca} order by valid_from`.execute(db);
    expect(hist.rows).toEqual([
      { price_cents: 45000, cerrado: true },
      { price_cents: 52000, cerrado: false },
    ]);
  });

  it("ajustar el stock a una cantidad deja UNA corrección con la diferencia", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 10);
    const ajustar = (objetivo: number) =>
      withStaff(db, staff, async (trx) => {
        const actual = await onHand(db, rosca);
        return callFn(trx, "record_stock_correction", [
          rosca,
          objetivo - actual,
          "difference",
          "ajuste desde productos especiales",
        ]);
      });
    await ajustar(30);
    expect(await onHand(db, rosca)).toBe(30);
    await ajustar(4);
    expect(await onHand(db, rosca)).toBe(4);
    const mv = await sql<{ type: string; qty: number }>`
      select type, qty::float8 as qty from inventory_movements where product_id = ${rosca} order by id`.execute(
      db,
    );
    expect(mv.rows).toEqual([
      { type: "INITIAL", qty: 10 },
      { type: "CORRECTION", qty: 20 },
      { type: "CORRECTION", qty: -26 },
    ]);
  });

  it("el nombre se cambia en la misma fila: la venta pasada conserva el nombre con el que se vendió", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 5);
    await posCheckout(db, staff, {
      items: [{ product_id: rosca, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 45000 }],
    });
    await withStaff(db, staff, (trx) =>
      sql`update products set name = 'Rosca de Reyes 2026' where id = ${rosca}`.execute(trx),
    );
    const oi = await sql<{ product_name: string }>`
      select product_name from order_items where product_id = ${rosca}`.execute(db);
    expect(oi.rows[0]!.product_name).toBe("Rosca de Reyes");
  });
});

describe("venta, agotado y producción", () => {
  it("vender baja el stock por el camino normal (pos_checkout → movimiento SALE)", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 3);
    await posCheckout(db, staff, {
      items: [{ product_id: rosca, qty: 3 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 135000 }],
    });
    expect(await onHand(db, rosca)).toBe(0);
    const mv = await sql<{ type: string; qty: number }>`
      select type, qty::float8 as qty from inventory_movements where product_id = ${rosca} order by id`.execute(
      db,
    );
    expect(mv.rows).toEqual([
      { type: "INITIAL", qty: 3 },
      { type: "SALE", qty: -3 },
    ]);
  });

  it("aparece en el tablero de producción y registrar producción lo repone", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 0);
    const enTablero = async () =>
      (
        await sql<{ n: string }>`select count(*)::text as n from products p
           where p.id = ${rosca} and p.deleted_at is null and p.is_active and p.track_stock`.execute(
          db,
        )
      ).rows[0]!.n;
    expect(await enTablero()).toBe("1");
    await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "record_production", [rosca, 24, "primera horneada", false]),
    );
    expect(await onHand(db, rosca)).toBe(24);
    // Desactivado sale del tablero (misma regla que cualquier producto).
    await sql`update products set is_active = false where id = ${rosca}`.execute(db);
    expect(await enTablero()).toBe("0");
  });
});

describe("desactivar y reactivar la temporada siguiente", () => {
  it("desactivar conserva ventas, movimientos y precios; reactivar devuelve el mismo producto", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 10);
    await posCheckout(db, staff, {
      items: [{ product_id: rosca, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 90000 }],
    });
    await withStaff(db, staff, (trx) =>
      sql`update products set is_active = false where id = ${rosca}`.execute(trx),
    );

    const resumen = async () =>
      (
        await sql<{ ventas: string; movimientos: string; precios: string; stock: number }>`
        select (select count(*) from order_items where product_id = ${rosca})::text as ventas,
               (select count(*) from inventory_movements where product_id = ${rosca})::text as movimientos,
               (select count(*) from product_prices where product_id = ${rosca})::text as precios,
               coalesce((select on_hand from inventory_levels where product_id = ${rosca}), 0)::float8 as stock`.execute(
          db,
        )
      ).rows[0]!;
    expect(await resumen()).toEqual({
      ventas: "1",
      movimientos: "2",
      precios: "1",
      stock: 8,
    });

    // La temporada siguiente: se reactiva la MISMA fila, con su historial intacto.
    await withStaff(db, staff, (trx) =>
      sql`update products set is_active = true where id = ${rosca}`.execute(trx),
    );
    expect((await flags(rosca)).is_active).toBe(true);
    expect(await resumen()).toEqual({
      ventas: "1",
      movimientos: "2",
      precios: "1",
      stock: 8,
    });
    expect(await precio(rosca, "pos")).toBe(45000);
  });

  it("queda auditado quién lo creó, lo renombró y lo desactivó", async () => {
    const rosca = await altaEspecial("Rosca de Reyes", 45000, 0);
    await withStaff(db, staff, (trx) =>
      sql`update products set name = 'Rosca grande' where id = ${rosca}`.execute(trx),
    );
    await withStaff(db, staff, (trx) =>
      sql`update products set is_active = false where id = ${rosca}`.execute(trx),
    );
    const logs = await sql<{
      action: string;
      staff_id: string | null;
      old_name: string | null;
      new_name: string | null;
      new_temporary: boolean | null;
      old_active: boolean | null;
      new_active: boolean | null;
    }>`
      select action, staff_id::text,
             old_data->>'name' as old_name, new_data->>'name' as new_name,
             (new_data->>'is_temporary')::boolean as new_temporary,
             (old_data->>'is_active')::boolean as old_active,
             (new_data->>'is_active')::boolean as new_active
      from audit_logs where entity = 'products' and entity_id = ${rosca} order by id`.execute(db);
    expect(logs.rows.map((r) => r.action)).toEqual(["INSERT", "UPDATE", "UPDATE"]);
    for (const r of logs.rows) expect(r.staff_id).toBe(staff);
    expect(logs.rows[0]!.new_temporary).toBe(true);
    expect(logs.rows[1]).toMatchObject({ old_name: "Rosca de Reyes", new_name: "Rosca grande" });
    expect(logs.rows[2]).toMatchObject({ old_active: true, new_active: false });
  });
});
