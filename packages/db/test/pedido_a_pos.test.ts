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
 * Enviar un pedido guardado al punto de venta para cobrar su saldo (migración 0082).
 *
 * Lo que se prueba aquí es la capa donde viven las garantías: `queue_order_for_pos` solo marca una
 * fecha y `record_payment` es el único camino por el que entra el dinero. La interfaz no puede
 * relajar nada de esto porque la base lo valida igual si alguien llama la función a mano.
 */
const { db, pool } = testDb();
let staff: string;
let staff2: string;
let croissant: string;

const pedido = (over: Record<string, unknown> = {}) => ({
  channel: "web",
  price_channel: "web",
  customer_name: "Ana",
  customer_phone: "6641112222",
  items: [{ product_id: croissant, qty: 2 }],
  ...over,
});

const crearPedido = (over: Record<string, unknown> = {}) =>
  withStaff(db, staff, (trx) =>
    callFn<string>(trx, "create_order", [JSON.stringify(pedido(over))]),
  );

const enviarAPos = (orderId: string, quien = staff) =>
  withStaff(db, quien, (trx) =>
    callFn<{
      queued: boolean;
      already?: boolean;
      reason?: string;
      folio: string;
      balance_cents: number;
      total_cents?: number;
      paid_cents?: number;
      sale_id?: string | null;
    }>(trx, "queue_order_for_pos", [orderId]),
  );

const pagar = (orderId: string, amount: number, over: Record<string, unknown> = {}) =>
  withStaff(db, staff, (trx) =>
    callFn<{ payment_id: string; sale_id: string | null; duplicate: boolean }>(
      trx,
      "record_payment",
      [
        JSON.stringify({
          order_id: orderId,
          provider: "cash",
          method: "cash",
          amount_cents: amount,
          ...over,
        }),
      ],
    ),
  );

const leerPedido = async (id: string) =>
  (
    await sql<{
      status: string;
      payment_status: string;
      total_cents: number;
      paid_cents: number;
      pos_queued_at: Date | null;
      pos_queued_by: string | null;
    }>`select status::text as status, payment_status::text as payment_status, total_cents,
              paid_cents, pos_queued_at, pos_queued_by
         from orders where id = ${id}`.execute(db)
  ).rows[0]!;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  staff2 = await createStaff(db, "cajera2@pdp.local");
  croissant = await createProduct(db, "Croissant", 4500);
  await withStaff(db, staff, (trx) =>
    callFn(trx, "record_production", [croissant, 50, null, null]),
  );
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("A y B · enviar al punto de venta, cualquiera sea el origen", () => {
  it("un pedido web guardado se envía con folio, total y saldo completos", async () => {
    const id = await crearPedido();
    const r = await enviarAPos(id);
    expect(r.queued).toBe(true);
    expect(r.already).toBe(false);
    expect(r.folio).toMatch(/^PDP-/);
    expect(r.total_cents).toBe(9000);
    expect(r.paid_cents).toBe(0);
    expect(r.balance_cents).toBe(9000);
    const o = await leerPedido(id);
    expect(o.pos_queued_at).not.toBeNull();
    expect(o.pos_queued_by).toBe(staff);
  });

  it("un pedido manual (canal admin) sigue exactamente el mismo flujo", async () => {
    const id = await crearPedido({ channel: "admin", price_channel: "pos" });
    const r = await enviarAPos(id);
    expect(r.queued).toBe(true);
    expect(r.balance_cents).toBeGreaterThan(0);
    expect((await leerPedido(id)).pos_queued_at).not.toBeNull();
  });

  it("el pedido NO se convierte en otro pedido ni se duplica al enviarlo", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    const n = await sql<{ n: string }>`select count(*) as n from orders`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });
});

describe("C · se conservan importes, notas y precios acordados", () => {
  it("descuento, envío, propina y notas por renglón sobreviven al envío", async () => {
    const id = await crearPedido({
      notes: "Tocar el timbre dos veces",
      delivery_fee_cents: 3000,
      tip_cents: 1500,
      fulfillment_type: "delivery",
      items: [{ product_id: croissant, qty: 1, notes: "Sin azúcar glas" }],
    });
    const r = await enviarAPos(id);
    expect(r.queued).toBe(true);

    const its = await sql<{ notes: string | null }>`
      select notes from order_items where order_id = ${id} order by sort_order`.execute(db);
    expect(its.rows[0]!.notes).toBe("Sin azúcar glas");

    const o = await sql<{
      delivery_fee_cents: number;
      tip_cents: number;
      notes: string | null;
    }>`select delivery_fee_cents, tip_cents, notes from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toMatchObject({
      delivery_fee_cents: 3000,
      tip_cents: 1500,
      notes: "Tocar el timbre dos veces",
    });
    // El saldo incluye envío y propina: es lo que hay que cobrar, no solo los productos.
    expect(r.balance_cents).toBe((await leerPedido(id)).total_cents);
  });

  it("un producto especial (temporal) se cobra igual que cualquier otro", async () => {
    /*
     * En este sistema un "producto especial" NO es un renglón sin producto: `create_order` exige
     * `product_id` siempre (responde "Producto <NULL> no existe"). Los especiales son productos
     * reales marcados `is_temporary`, como los crea produccion/especiales-actions.ts. Se prueba
     * así porque es como el modelo los representa, no como uno esperaría que fuera.
     */
    const especial = await createProduct(db, "Pastel personalizado 3 pisos", 85000, {
      allowPreorder: false,
    });
    await sql`update products set is_temporary = true where id = ${especial}`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [especial, 1, null, null]),
    );
    const id = await crearPedido({ items: [{ product_id: especial, qty: 1 }] });
    const r = await enviarAPos(id);
    expect(r.queued).toBe(true);
    expect(r.balance_cents).toBe(85000);
    const it = await sql<{ product_name: string }>`
      select product_name from order_items where order_id = ${id}`.execute(db);
    expect(it.rows[0]!.product_name).toBe("Pastel personalizado 3 pisos");
  });

  it("cambiar el precio del catálogo NO cambia el precio acordado del pedido", async () => {
    // La garantía que pide el flujo: cobrar lo acordado, no lo que diga el catálogo hoy.
    const id = await crearPedido();
    const antes = await leerPedido(id);
    await sql`update product_prices set price_cents = 99900 where product_id = ${croissant}`.execute(
      db,
    );
    const r = await enviarAPos(id);
    expect(r.total_cents).toBe(antes.total_cents);
    expect(r.balance_cents).toBe(antes.total_cents);
    const it = await sql<{ unit_price_cents: number }>`
      select unit_price_cents from order_items where order_id = ${id}`.execute(db);
    expect(it.rows[0]!.unit_price_cents).toBe(4500);
  });
});
describe("D · anticipos", () => {
  it("con un anticipo aplicado solo prepara el saldo, no el total", async () => {
    const id = await crearPedido(); // total 9000
    await pagar(id, 4000, { idempotency_key: "anticipo-1" });
    const o1 = await leerPedido(id);
    expect(o1.paid_cents).toBe(4000);
    expect(o1.payment_status).toBe("partial");

    const r = await enviarAPos(id);
    expect(r.total_cents).toBe(9000);
    expect(r.paid_cents).toBe(4000);
    expect(r.balance_cents).toBe(5000); // no 9000
  });

  it("no contabiliza dos veces el anticipo: cobrar el saldo deja el pedido pagado y una sola venta", async () => {
    const id = await crearPedido();
    await pagar(id, 4000, { idempotency_key: "anticipo-2" });
    await enviarAPos(id);
    const r = await pagar(id, 5000, { idempotency_key: "saldo-2" });
    expect(r.sale_id).not.toBeNull();
    const o = await leerPedido(id);
    expect(o.paid_cents).toBe(9000);
    expect(o.payment_status).toBe("paid");
    const ventas = await sql<{
      n: string;
    }>`select count(*) as n from sales where order_id = ${id}`.execute(db);
    expect(Number(ventas.rows[0]!.n)).toBe(1);
  });
});

describe("E · un pedido pagado no se cobra otra vez", () => {
  it("al enviarlo responde already_paid y devuelve la venta existente", async () => {
    const id = await crearPedido();
    const pago = await pagar(id, 9000, { idempotency_key: "completo-1" });
    const r = await enviarAPos(id);
    expect(r.queued).toBe(false);
    expect(r.reason).toBe("already_paid");
    expect(r.balance_cents).toBe(0);
    expect(r.sale_id).toBe(pago.sale_id);
  });

  it("intentar cobrar de nuevo lo rechaza la base, no la interfaz", async () => {
    const id = await crearPedido();
    await pagar(id, 9000, { idempotency_key: "completo-2" });
    await expect(pagar(id, 9000, { idempotency_key: "otro-cobro" })).rejects.toThrow(
      /excede el total/i,
    );
  });
});

describe("F · idempotencia del envío", () => {
  it("enviarlo dos veces recupera el MISMO pedido en cola, no crea otro", async () => {
    const id = await crearPedido();
    const a = await enviarAPos(id);
    const b = await enviarAPos(id);
    expect(a.already).toBe(false);
    expect(b.already).toBe(true);
    expect(b.folio).toBe(a.folio);
    const o = await leerPedido(id);
    expect(o.pos_queued_by).toBe(staff); // el primero, no se sobrescribe
  });

  it("dos operadores enviándolo a la vez no dejan dos pedidos en cola", async () => {
    const id = await crearPedido();
    const [x, y] = await Promise.all([enviarAPos(id, staff), enviarAPos(id, staff2)]);
    expect(x.queued && y.queued).toBe(true);
    // Uno de los dos lo marcó; el otro lo encontró ya marcado. Nunca los dos como primeros.
    expect([x.already, y.already].filter(Boolean).length).toBe(1);
    const n = await sql<{
      n: string;
    }>`select count(*) as n from orders where pos_queued_at is not null`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(1);
  });
});

describe("G · dos cajeros no cobran dos veces el mismo saldo", () => {
  it("el segundo cobro del mismo saldo se rechaza", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    const r = await Promise.allSettled([
      pagar(id, 9000, { idempotency_key: "cajero-a" }),
      pagar(id, 9000, { idempotency_key: "cajero-b" }),
    ]);
    const ok = r.filter((x) => x.status === "fulfilled");
    const mal = r.filter((x) => x.status === "rejected");
    expect(ok.length).toBe(1);
    expect(mal.length).toBe(1);
    const o = await leerPedido(id);
    expect(o.paid_cents).toBe(9000); // no 18000
  });

  it("reintentar con la MISMA clave devuelve el pago ya registrado, sin cobrar de nuevo", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    const a = await pagar(id, 9000, { idempotency_key: "reintento-1" });
    const b = await pagar(id, 9000, { idempotency_key: "reintento-1" });
    expect(b.duplicate).toBe(true);
    expect(b.payment_id).toBe(a.payment_id);
    expect((await leerPedido(id)).paid_cents).toBe(9000);
  });
});

describe("H · enviar no tiene efectos de negocio", () => {
  it("no toca inventario, no crea venta, no crea pago y no mueve caja", async () => {
    const id = await crearPedido();
    const stockAntes = await onHand(db, croissant);
    const antes = await sql<{ ventas: string; pagos: string; movs: string }>`
      select (select count(*) from sales) as ventas,
             (select count(*) from payments) as pagos,
             (select count(*) from inventory_movements) as movs`.execute(db);

    await enviarAPos(id);
    await enviarAPos(id); // y dos veces, por si acaso

    const despues = await sql<{ ventas: string; pagos: string; movs: string }>`
      select (select count(*) from sales) as ventas,
             (select count(*) from payments) as pagos,
             (select count(*) from inventory_movements) as movs`.execute(db);
    expect(despues.rows[0]).toEqual(antes.rows[0]);
    expect(await onHand(db, croissant)).toBe(stockAntes);
    // Y el estado operativo del pedido no cambió: enviar no es cobrar ni entregar.
    expect((await leerPedido(id)).payment_status).toBe("pending");
  });
});

describe("I y K · recuperación y casos no elegibles", () => {
  it("el pedido en cola se recupera consultando la base, no memoria", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    const cola = await sql<{ id: string; folio: string }>`
      select id, folio from orders
       where pos_queued_at is not null and payment_status <> 'paid'
         and status not in ('cancelled','refunded') and total_cents > paid_cents`.execute(db);
    expect(cola.rows.map((r) => r.id)).toEqual([id]);
  });

  it("al cobrarse sale de la cola solo porque ya no tiene saldo", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    await pagar(id, 9000, { idempotency_key: "sale-de-cola" });
    const cola = await sql<{ n: string }>`
      select count(*) as n from orders
       where pos_queued_at is not null and payment_status <> 'paid' and total_cents > paid_cents`.execute(
      db,
    );
    expect(Number(cola.rows[0]!.n)).toBe(0);
    // La marca de envío se conserva: es trazabilidad de quién lo mandó a cobrar.
    expect((await leerPedido(id)).pos_queued_at).not.toBeNull();
  });

  it("un pedido cancelado no se puede enviar y dice por qué", async () => {
    const id = await crearPedido();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "change_order_status", [id, "cancelled", "prueba"]),
    );
    await expect(enviarAPos(id)).rejects.toThrow(/no se puede cobrar/i);
  });

  it("un pedido inexistente no se puede enviar", async () => {
    await expect(enviarAPos("00000000-0000-0000-0000-000000000000")).rejects.toThrow(/no existe/i);
  });
});

describe("L · un pago confirmado actualiza el pedido sin falsear el estado", () => {
  it("un pago parcial deja parcial, no pagado, y no crea venta todavía", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    const r = await pagar(id, 3000, { idempotency_key: "parcial-L" });
    expect(r.sale_id).toBeNull();
    const o = await leerPedido(id);
    expect(o.payment_status).toBe("partial");
    const ventas = await sql<{
      n: string;
    }>`select count(*) as n from sales where order_id = ${id}`.execute(db);
    expect(Number(ventas.rows[0]!.n)).toBe(0);
  });

  it("un pago pendiente de confirmación NO cuenta como dinero recibido", async () => {
    const id = await crearPedido();
    await enviarAPos(id);
    await pagar(id, 9000, { status: "pending", idempotency_key: "en-vuelo" });
    const o = await leerPedido(id);
    expect(o.paid_cents).toBe(0);
    expect(o.payment_status).not.toBe("paid");
    // Y el saldo sigue completo, así que el pedido continúa en la cola.
    expect((await enviarAPos(id)).balance_cents).toBe(9000);
  });
});
