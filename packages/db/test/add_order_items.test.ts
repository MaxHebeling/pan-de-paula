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
 * Agregar productos a un pedido que todavía no se ha cobrado (0084).
 *
 * El caso: la persona viene a retirar su pedido y en el mostrador pide dos conchas más.
 *
 * Lo que de verdad se prueba aquí no es que se inserte un renglón —eso es un `insert`— sino las
 * cuatro reglas que protegen el dinero: que no se pueda tocar un pedido ya cobrado, que el
 * descuento no se regale, que el precio salga del canal del pedido y que el stock de lo agregado
 * sí se descuente al cobrar.
 */
const { db, pool } = testDb();
let staff: string;
let concha: string;

type Resultado = {
  folio: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_status: string;
  duplicate: boolean;
  added: { product_name: string; qty: string | number; unit_price_cents: number }[];
};

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  concha = await createProduct(db, "Concha", 3000);
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [concha, 50, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Pedido web de 2 conchas = $60.00, sin pagar. Es el estado en que llega quien viene a retirar. */
async function pedidoWeb(extra: Record<string, unknown> = {}) {
  return callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      fulfillment_type: "pickup",
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [{ product_id: concha, qty: 2 }],
      ...extra,
    }),
  ]);
}

function agregar(orderId: string, items: Record<string, unknown>[], idem: string) {
  return withStaff(db, staff, (trx) =>
    callFn<Resultado>(trx, "add_order_items", [
      JSON.stringify({ order_id: orderId, idempotency_key: idem, items }),
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

describe("agregar productos a un pedido", () => {
  it("sube el total y el saldo por cobrar, sin tocar lo que ya estaba", async () => {
    const id = await pedidoWeb();
    const r = await agregar(id, [{ product_id: concha, qty: 3 }], "add-1");

    expect(r.duplicate).toBe(false);
    expect(r.total_cents).toBe(15000); // 2 + 3 conchas a $30
    expect(r.balance_cents).toBe(15000);
    expect(await pedido(id)).toMatchObject({ subtotal_cents: 15000, total_cents: 15000 });

    // Los renglones originales siguen ahí: se agrega, no se reemplaza.
    const renglones = await sql<{ n: number }>`select count(*)::int as n from order_items
       where order_id = ${id}`.execute(db);
    expect(renglones.rows[0]!.n).toBe(2);
  });

  it("la misma clave no agrega dos veces", async () => {
    const id = await pedidoWeb();
    const a = await agregar(id, [{ product_id: concha, qty: 1 }], "add-doble");
    const b = await agregar(id, [{ product_id: concha, qty: 1 }], "add-doble");

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.total_cents).toBe(a.total_cents);
    // Un doble clic en el mostrador no puede cobrarle al cliente una concha de más.
    expect((await pedido(id)).total_cents).toBe(9000);
  });

  it("NO se puede agregar a un pedido ya cobrado: eso es una venta nueva", async () => {
    const id = await pedidoWeb();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: id,
          provider: "cash",
          method: "cash",
          amount_cents: 6000,
          idempotency_key: "pago-total",
        }),
      ]),
    );
    // Al quedar cubierto, `record_payment` llamó a `finalize_sale`: la venta existe y el total
    // quedó congelado en ella. Agregar aquí separaría el pedido de su propia venta.
    const venta = await sql<{ n: number }>`select count(*)::int as n from sales
       where order_id = ${id}`.execute(db);
    expect(venta.rows[0]!.n).toBe(1);

    await expect(agregar(id, [{ product_id: concha, qty: 1 }], "add-tarde")).rejects.toThrow(
      /ya está cobrado/i,
    );
    expect((await pedido(id)).total_cents).toBe(6000);
  });

  it("no se puede agregar a un pedido cancelado", async () => {
    const id = await pedidoWeb();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "cancelled", "prueba"]),
    );
    await expect(agregar(id, [{ product_id: concha, qty: 1 }], "add-cancelado")).rejects.toThrow(
      /cancelled|cancelado/i,
    );
  });

  it("el descuento del cupón se congela: no se regala sobre lo que se agrega", async () => {
    await sql`insert into coupons(code, name, kind, value_bps) values ('DIEZ', '10%', 'pct', 1000)`.execute(
      db,
    );
    const id = await pedidoWeb({ coupon_code: "DIEZ" });
    const antes = await pedido(id);
    expect(antes).toMatchObject({ subtotal_cents: 6000, discount_cents: 600, total_cents: 5400 });

    await agregar(id, [{ product_id: concha, qty: 2 }], "add-cupon");
    const despues = await pedido(id);

    // El subtotal sube, el descuento NO: el cupón se aplicó al pedido que se hizo, no al pan que
    // se antojó al llegar. Recalcularlo daría 1200 y regalaría $6 de margen.
    expect(despues.subtotal_cents).toBe(12000);
    expect(despues.discount_cents).toBe(600);
    expect(despues.total_cents).toBe(11400);
  });

  it("cobra al precio del canal del pedido, no al de mostrador", async () => {
    // Mismo producto, precio de mostrador más caro que el de catálogo.
    await sql`insert into product_prices(product_id, channel, kind, price_cents)
              values (${concha}, 'pos', 'regular', 5000)`.execute(db);

    const web = await pedidoWeb();
    const rWeb = await agregar(web, [{ product_id: concha, qty: 1 }], "add-web");
    expect(rWeb.added[0]!.unit_price_cents).toBe(3000);

    const pos = await callFn<string>(db, "create_order", [
      JSON.stringify({
        channel: "pos",
        customer_name: "Mostrador",
        items: [{ product_id: concha, qty: 1 }],
      }),
    ]);
    const rPos = await agregar(pos, [{ product_id: concha, qty: 1 }], "add-pos");
    expect(rPos.added[0]!.unit_price_cents).toBe(5000);
  });

  it("un producto agotado no se agrega, y se dice antes de cobrar", async () => {
    await sql`update business_settings set allow_negative_stock = false`.execute(db);
    const agotado = await createProduct(db, "Baguette", 4000, { allowPreorder: false });
    const id = await pedidoWeb();

    await expect(agregar(id, [{ product_id: agotado, qty: 1 }], "add-agotado")).rejects.toThrow(
      /agotado/i,
    );
    // Y el pedido quedó intacto: el rechazo no deja medio agregado.
    expect((await pedido(id)).total_cents).toBe(6000);
  });

  it("con anticipo queda parcial, y al cobrar se descuenta el stock de lo agregado", async () => {
    const id = await pedidoWeb();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: id,
          provider: "cash",
          method: "cash",
          amount_cents: 2000,
          idempotency_key: "anticipo",
        }),
      ]),
    );

    const r = await agregar(id, [{ product_id: concha, qty: 3 }], "add-anticipo");
    expect(r.total_cents).toBe(15000);
    expect(r.paid_cents).toBe(2000);
    expect(r.balance_cents).toBe(13000);
    expect(r.payment_status).toBe("partial");
    expect(await onHand(db, concha)).toBe(50); // todavía no se descuenta nada

    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: id,
          provider: "cash",
          method: "cash",
          amount_cents: 13000,
          idempotency_key: "resto",
        }),
      ]),
    );
    // Las 5 conchas salen del inventario: las 2 del pedido y las 3 agregadas en el mostrador.
    expect(await onHand(db, concha)).toBe(45);
  });

  it("deja registro de qué se agregó y quién lo hizo", async () => {
    const id = await pedidoWeb();
    await agregar(id, [{ product_id: concha, qty: 2 }], "add-bitacora");

    const reg = await sql<{
      staff_id: string;
      total_before: number;
      total_after: number;
      items: { product_name: string; qty: string }[];
    }>`select staff_id, total_before, total_after, items from order_item_additions
         where order_id = ${id}`.execute(db);

    // `orders` tiene auditoría automática, `order_items` no: sin esta tabla constaría que el total
    // cambió, pero no qué pan se agregó ni quién lo cobró.
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0]).toMatchObject({ staff_id: staff, total_before: 6000, total_after: 12000 });
    expect(reg.rows[0]!.items[0]!.product_name).toBe("Concha");
  });
});
