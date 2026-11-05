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
 * Editar los productos de un pedido sin cobrar (0085): cambiar cantidades, quitar, agregar y
 * cambiar un producto por otro.
 *
 * Lo que se prueba son las reglas que protegen el dinero: quién puede, que un pedido cobrado no se
 * toque, que el total no baje de lo ya pagado, que el descuento nunca suba y que, si el anticipo
 * cubre exacto el pedido nuevo, la venta se registre con su stock.
 */
const { db, pool } = testDb();
let admin: string;
let cajera: string;
let concha: string;
let dona: string;

type Resultado = {
  folio: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_status: string;
  sale_id: string | null;
  duplicate: boolean;
};

type Renglon = { order_item_id?: string; product_id?: string; qty: number; notes?: string };

beforeEach(async () => {
  await truncateAll(db);
  admin = await createStaff(db, "admin@pdp.local", "admin");
  cajera = await createStaff(db, "caja@pdp.local", "cashier");
  concha = await createProduct(db, "Concha", 3000);
  dona = await createProduct(db, "Dona", 2000);
  await withStaff(db, admin, (trx) => callFn(trx, "record_production", [concha, 50, null, null]));
  await withStaff(db, admin, (trx) => callFn(trx, "record_production", [dona, 50, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Pedido web: 4 conchas ($120) + 1 dona ($20) = $140, sin pagar. */
async function pedidoWeb(extra: Record<string, unknown> = {}) {
  return callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      fulfillment_type: "pickup",
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [
        { product_id: concha, qty: 4 },
        { product_id: dona, qty: 1 },
      ],
      ...extra,
    }),
  ]);
}

async function renglones(orderId: string) {
  return (
    await sql<{ id: string; product_id: string; qty: string; unit_price_cents: number }>`
      select id, product_id, qty::text, unit_price_cents from order_items
       where order_id = ${orderId} order by sort_order`.execute(db)
  ).rows;
}

function editar(orderId: string, items: Renglon[], idem: string, staff = admin, reason?: string) {
  return withStaff(db, staff, (trx) =>
    callFn<Resultado>(trx, "edit_order_items", [
      JSON.stringify({ order_id: orderId, idempotency_key: idem, items, reason }),
    ]),
  );
}

function pagar(orderId: string, cents: number, idem: string, status = "paid") {
  return withStaff(db, admin, (trx) =>
    callFn(trx, "record_payment", [
      JSON.stringify({
        order_id: orderId,
        provider: "cash",
        method: "cash",
        amount_cents: cents,
        status,
        idempotency_key: idem,
      }),
    ]),
  );
}

const pedido = async (id: string) =>
  (
    await sql<{
      subtotal_cents: number;
      discount_cents: number;
      total_cents: number;
      payment_status: string;
    }>`select subtotal_cents, discount_cents, total_cents, payment_status::text as payment_status
         from orders where id = ${id}`.execute(db)
  ).rows[0]!;

describe("editar los productos de un pedido", () => {
  it("cambia cantidades, quita, agrega y cambia un producto por otro", async () => {
    const id = await pedidoWeb();
    const [c, d] = await renglones(id);

    // Bajar conchas de 4 a 2.
    let r = await editar(
      id,
      [
        { order_item_id: c!.id, qty: 2 },
        { order_item_id: d!.id, qty: 1 },
      ],
      "e1",
    );
    expect(r.total_cents).toBe(8000);

    // Quitar la dona (no viene en la lista final).
    r = await editar(id, [{ order_item_id: c!.id, qty: 2 }], "e2");
    expect(r.total_cents).toBe(6000);
    expect(await renglones(id)).toHaveLength(1);

    // Cambiar las conchas por 3 donas: quitar uno y agregar otro.
    r = await editar(id, [{ product_id: dona, qty: 3 }], "e3");
    expect(r.total_cents).toBe(6000);
    const final = await renglones(id);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ product_id: dona, qty: "3.000", unit_price_cents: 2000 });
    expect(r.payment_status).toBe("pending");
  });

  it("un renglón conservado mantiene su precio pactado aunque el catálogo suba", async () => {
    const id = await pedidoWeb();
    const [c, d] = await renglones(id);
    await sql`update product_prices set price_cents = 9900 where product_id = ${concha}`.execute(
      db,
    );

    const r = await editar(
      id,
      [
        { order_item_id: c!.id, qty: 5 },
        { order_item_id: d!.id, qty: 1 },
      ],
      "precio",
    );
    // 5 × $30 (precio del pedido, no $99 del catálogo nuevo) + $20.
    expect(r.total_cents).toBe(17000);
  });

  it("la misma clave no edita dos veces", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    const a = await editar(id, [{ order_item_id: c!.id, qty: 1 }], "doble");
    const b = await editar(
      id,
      [
        { order_item_id: c!.id, qty: 1 },
        { product_id: dona, qty: 9 },
      ],
      "doble",
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect((await pedido(id)).total_cents).toBe(3000);
  });

  it("SOLO administradores y gerencia: la cajera no puede", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    await expect(editar(id, [{ order_item_id: c!.id, qty: 1 }], "caja", cajera)).rejects.toThrow(
      /permiso/i,
    );
    expect((await pedido(id)).total_cents).toBe(14000);

    for (const role of ["super_admin", "owner", "ceo", "manager"]) {
      const s = await createStaff(db, `${role}@pdp.local`, role);
      await expect(
        editar(id, [{ order_item_id: c!.id, qty: 4 }], `ok-${role}`, s),
      ).resolves.toBeTruthy();
    }
    for (const role of ["sales", "production", "marketing"]) {
      const s = await createStaff(db, `${role}@pdp.local`, role);
      await expect(editar(id, [{ order_item_id: c!.id, qty: 1 }], `no-${role}`, s)).rejects.toThrow(
        /permiso/i,
      );
    }
  });

  it("NO se edita un pedido ya cobrado", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    await pagar(id, 14000, "total");
    await expect(editar(id, [{ order_item_id: c!.id, qty: 1 }], "tarde")).rejects.toThrow(
      /ya está cobrado/i,
    );
    expect((await pedido(id)).total_cents).toBe(14000);
  });

  it("no deja el pedido vacío ni acepta renglones de otro pedido", async () => {
    const id = await pedidoWeb();
    const otro = await pedidoWeb();
    const [ajeno] = await renglones(otro);
    await expect(editar(id, [], "vacio")).rejects.toThrow(/al menos un producto/i);
    await expect(editar(id, [{ order_item_id: ajeno!.id, qty: 1 }], "ajeno")).rejects.toThrow(
      /no pertenece/i,
    );
    // El rechazo no deja la edición a medias.
    expect(await renglones(id)).toHaveLength(2);
  });

  it("el total no puede bajar de lo ya pagado", async () => {
    const id = await pedidoWeb();
    const [c, d] = await renglones(id);
    await pagar(id, 10000, "anticipo");

    // Quedaría en $60 con $100 pagados: primero hay que reembolsar.
    await expect(editar(id, [{ order_item_id: c!.id, qty: 2 }], "abajo")).rejects.toThrow(
      /por debajo de lo ya pagado/i,
    );
    expect((await pedido(id)).total_cents).toBe(14000);

    // Bajar sin pasar del anticipo sí se puede, y queda parcial.
    const r = await editar(
      id,
      [
        { order_item_id: c!.id, qty: 3 },
        { order_item_id: d!.id, qty: 1 },
      ],
      "ok",
    );
    expect(r).toMatchObject({ total_cents: 11000, balance_cents: 1000, payment_status: "partial" });
  });

  it("si el anticipo cubre exacto el pedido nuevo, queda pagado y se registra la venta con su stock", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    await pagar(id, 6000, "anticipo");

    const r = await editar(id, [{ order_item_id: c!.id, qty: 2 }], "exacto");
    expect(r).toMatchObject({ total_cents: 6000, balance_cents: 0, payment_status: "paid" });
    expect(r.sale_id).toBeTruthy();
    expect(await onHand(db, concha)).toBe(48);
    expect(await onHand(db, dona)).toBe(50); // la dona se quitó: no sale del inventario
  });

  it("con un pago en proceso no se edita", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    await pagar(id, 14000, "link-mp", "pending");
    await expect(editar(id, [{ order_item_id: c!.id, qty: 1 }], "proceso")).rejects.toThrow(
      /pago en proceso/i,
    );
  });

  it("el descuento del cupón baja con el pedido, pero nunca sube", async () => {
    await sql`insert into coupons(code, name, kind, value_bps) values ('DIEZ', '10%', 'pct', 1000)`.execute(
      db,
    );
    const id = await pedidoWeb({ coupon_code: "DIEZ" });
    const [c, d] = await renglones(id);
    expect(await pedido(id)).toMatchObject({ subtotal_cents: 14000, discount_cents: 1400 });

    // Baja a $60: el 10 % ahora es $6. Dejar los $14 regalaría casi la cuarta parte del pedido.
    await editar(id, [{ order_item_id: c!.id, qty: 2 }], "baja");
    expect(await pedido(id)).toMatchObject({
      subtotal_cents: 6000,
      discount_cents: 600,
      total_cents: 5400,
    });

    // Sube de nuevo: el descuento NO vuelve a crecer (mismo criterio que agregar, 0084).
    await editar(
      id,
      [
        { order_item_id: c!.id, qty: 2 },
        { product_id: dona, qty: 5 },
      ],
      "sube",
    );
    expect(await pedido(id)).toMatchObject({
      subtotal_cents: 16000,
      discount_cents: 600,
      total_cents: 15400,
    });
    void d;
  });

  it("si el cupón exige una compra mínima, no se puede bajar de ella", async () => {
    await sql`insert into coupons(code, name, kind, value_cents, min_subtotal_cents)
              values ('MENOS20', '$20', 'amount', 2000, 10000)`.execute(db);
    const id = await pedidoWeb({ coupon_code: "MENOS20" });
    const [c] = await renglones(id);
    await expect(editar(id, [{ order_item_id: c!.id, qty: 2 }], "minimo")).rejects.toThrow(
      /compra mínima/i,
    );
  });

  it("un producto agotado no se agrega ni se le sube la cantidad", async () => {
    await sql`update business_settings set allow_negative_stock = false`.execute(db);
    const baguette = await createProduct(db, "Baguette", 4000, { allowPreorder: false });
    const id = await pedidoWeb();
    const [c, d] = await renglones(id);
    await expect(
      editar(
        id,
        [
          { order_item_id: c!.id, qty: 4 },
          { order_item_id: d!.id, qty: 1 },
          { product_id: baguette, qty: 1 },
        ],
        "agotado",
      ),
    ).rejects.toThrow(/no alcanza/i);
    expect(await renglones(id)).toHaveLength(2);
  });

  it("deja registro de cómo estaba, cómo quedó, quién y por qué", async () => {
    const id = await pedidoWeb();
    const [c] = await renglones(id);
    await editar(id, [{ order_item_id: c!.id, qty: 1 }], "bitacora", admin, "El cliente llamó");

    const reg = await sql<{
      staff_id: string;
      reason: string;
      total_before: number;
      total_after: number;
      items_before: unknown[];
      items_after: unknown[];
    }>`select staff_id, reason, total_before, total_after, items_before, items_after
         from order_item_edits where order_id = ${id}`.execute(db);
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0]).toMatchObject({
      staff_id: admin,
      reason: "El cliente llamó",
      total_before: 14000,
      total_after: 3000,
    });
    expect(reg.rows[0]!.items_before).toHaveLength(2);
    expect(reg.rows[0]!.items_after).toHaveLength(1);
  });
});
