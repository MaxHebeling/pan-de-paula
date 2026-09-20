/**
 * Referencia CONTABLE del pago (`payments.reference`) — base de datos.
 *
 * La regla del dueño: cada PAGO lleva su número o código de referencia tal cual se escribe, se conserva
 * para siempre y en un pago dividido cada parte lleva la suya (nunca una sola para toda la venta).
 *
 * Cubre además la frontera que no se puede borronear: la referencia contable NO es el identificador del
 * proveedor. `external_id` (id de Mercado Pago), `external_status`, `idempotency_key` y `metadata` los
 * escribe la integración y `set_payment_reference` no los toca.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let product: string;

type PaymentRow = {
  id: string;
  method: string;
  amount_cents: number;
  reference: string | null;
  external_id: string | null;
  external_status: string | null;
  idempotency_key: string | null;
  metadata: Record<string, unknown>;
};

const paymentsOf = async (orderId: string) =>
  (
    await sql<PaymentRow>`select id, method::text as method, amount_cents, reference, external_id, external_status,
                                 idempotency_key, metadata
                          from payments where order_id = ${orderId} order by created_at`.execute(db)
  ).rows;

/** Pedido de mostrador (create_order) al que se le registran pagos uno por uno. */
async function counterOrder(totalQty = 2) {
  return callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "admin",
      fulfillment_type: "pickup",
      customer_name: "Conciliación",
      items: [{ product_id: product, qty: totalQty }],
    }),
  ]);
}

async function pay(orderId: string, p: Record<string, unknown>) {
  return withStaff(db, staff, (trx) =>
    callFn<{ payment_id: string; sale_id: string | null }>(trx, "record_payment", [
      JSON.stringify({ order_id: orderId, ...p }),
    ]),
  );
}

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  product = await createProduct(db, "Concha", 3000);
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [product, 50, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("captura de la referencia contable", () => {
  it("transferencia CON referencia: se guarda tal cual se escribió", async () => {
    const order = await counterOrder();
    await pay(order, {
      provider: "manual",
      method: "transfer",
      amount_cents: 6000,
      reference: "BANORTE-483920",
    });
    const [p] = await paymentsOf(order);
    expect(p!.reference).toBe("BANORTE-483920"); // sin mayúsculas forzadas ni reformateo
    expect(p!.external_id).toBeNull();
  });

  it("transferencia SIN referencia: queda en null, no en cadena vacía", async () => {
    const order = await counterOrder();
    await pay(order, { provider: "manual", method: "transfer", amount_cents: 6000 });
    const [p] = await paymentsOf(order);
    expect(p!.reference).toBeNull();
  });

  it("tarjeta con referencia: el external_id del proveedor NO se pisa", async () => {
    const order = await counterOrder();
    await pay(order, {
      provider: "manual",
      method: "card_terminal",
      amount_cents: 6000,
      reference: "AUT-778812",
      external_id: "term-xyz-001",
      external_status: "approved",
    });
    const [p] = await paymentsOf(order);
    expect(p!.reference).toBe("AUT-778812");
    expect(p!.external_id).toBe("term-xyz-001");
    expect(p!.external_status).toBe("approved");
  });

  it("Mercado Pago: el id del proveedor vive en external_id, no en reference", async () => {
    const order = await counterOrder();
    await callFn(db, "apply_mercadopago_payment", [
      JSON.stringify({
        order_id: order,
        external_id: "mp-55501",
        mp_status: "approved",
        amount_cents: 6000,
      }),
    ]);
    const [p] = await paymentsOf(order);
    expect(p!.external_id).toBe("mp-55501");
    expect(p!.reference).toBeNull(); // el webhook no inventa referencia contable
  });
});

describe("pago dividido: una referencia POR PARTE", () => {
  it("dos transferencias del mismo monto con referencias distintas: dos pagos, dos referencias", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: product, qty: 2 }],
      idempotency_key: "split-dos-transfer",
      payments: [
        { provider: "manual", method: "transfer", amount_cents: 3000, reference: "SPEI-AAA-111" },
        { provider: "manual", method: "transfer", amount_cents: 3000, reference: "SPEI-BBB-222" },
      ],
    });
    expect(r.sale_id).toBeTruthy();
    const pays = await paymentsOf(r.order_id as string);
    expect(pays).toHaveLength(2); // mismo método y mismo monto: la segunda parte NO se trata como duplicado
    expect(pays.map((p) => p.reference)).toEqual(["SPEI-AAA-111", "SPEI-BBB-222"]);
    expect(new Set(pays.map((p) => p.idempotency_key)).size).toBe(2);
  });

  it("transferencia + tarjeta: cada parte conserva su método, su monto y su referencia", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: product, qty: 2 }],
      idempotency_key: "split-mixto",
      payments: [
        { provider: "manual", method: "transfer", amount_cents: 4000, reference: "SPEI-9001" },
        { provider: "manual", method: "card_terminal", amount_cents: 2000, reference: "AUT-4477" },
      ],
    });
    const pays = await paymentsOf(r.order_id as string);
    expect(pays.map((p) => ({ m: p.method, a: p.amount_cents, ref: p.reference }))).toEqual([
      { m: "transfer", a: 4000, ref: "SPEI-9001" },
      { m: "card_terminal", a: 2000, ref: "AUT-4477" },
    ]);
  });

  it("efectivo + transferencia: el efectivo puede ir sin referencia y la transferencia con la suya", async () => {
    const sessionId = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [0]),
    );
    const r = await posCheckout(db, staff, {
      items: [{ product_id: product, qty: 2 }],
      idempotency_key: "split-efectivo",
      register_session_id: sessionId,
      payments: [
        { provider: "cash", method: "cash", amount_cents: 1000, tendered_cents: 1000 },
        { provider: "manual", method: "transfer", amount_cents: 5000, reference: "SPEI-3030" },
      ],
    });
    const pays = await paymentsOf(r.order_id as string);
    expect(pays.map((p) => p.reference)).toEqual([null, "SPEI-3030"]);
  });
});

describe("set_payment_reference (corregir una referencia ya registrada)", () => {
  async function paidOrder(reference?: string) {
    const order = await counterOrder();
    const r = await pay(order, {
      provider: "manual",
      method: "transfer",
      amount_cents: 6000,
      ...(reference ? { reference } : {}),
    });
    return { order, paymentId: r.payment_id };
  }

  it("corrige el dedazo y deja el valor anterior en la auditoría", async () => {
    const { paymentId } = await paidOrder("BANORTE-48390");
    const res = await withStaff(db, staff, (trx) =>
      callFn<{ changed: boolean; old_reference: string; reference: string }>(
        trx,
        "set_payment_reference",
        [paymentId, "BANORTE-483920"],
      ),
    );
    expect(res).toMatchObject({
      changed: true,
      old_reference: "BANORTE-48390",
      reference: "BANORTE-483920",
    });
    const rows = await sql<{
      old_data: { reference: string | null };
      new_data: { reference: string | null };
      staff_id: string | null;
    }>`select old_data, new_data, staff_id from audit_logs
       where entity = 'payments' and action = 'UPDATE' and entity_id = ${paymentId}
       order by id desc limit 1`.execute(db);
    expect(rows.rows[0]!.old_data.reference).toBe("BANORTE-48390");
    expect(rows.rows[0]!.new_data.reference).toBe("BANORTE-483920");
    expect(rows.rows[0]!.staff_id).toBe(staff); // quién la cambió
  });

  it("captura una referencia que faltaba y persiste al volver a leer", async () => {
    const { paymentId } = await paidOrder();
    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_payment_reference", [paymentId, "  TRX-8493021  "]),
    );
    const r = await sql<{
      reference: string;
    }>`select reference from payments where id = ${paymentId}`.execute(db);
    expect(r.rows[0]!.reference).toBe("TRX-8493021"); // recorta espacios, conserva el resto
  });

  it("no toca los identificadores del proveedor", async () => {
    const order = await counterOrder();
    const r = await pay(order, {
      provider: "manual",
      method: "card_terminal",
      amount_cents: 6000,
      external_id: "term-999",
      external_status: "approved",
      idempotency_key: "idem-term-999",
      metadata: { raw: { auth: "x" } },
    });
    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_payment_reference", [r.payment_id, "AUT-001"]),
    );
    const [p] = await paymentsOf(order);
    expect(p).toMatchObject({
      reference: "AUT-001",
      external_id: "term-999",
      external_status: "approved",
      idempotency_key: "idem-term-999",
    });
    expect(p!.metadata).toEqual({ raw: { auth: "x" } });
  });

  it("vaciarla la borra; repetir el mismo valor no marca cambio", async () => {
    const { paymentId } = await paidOrder("SPEI-1");
    const same = await withStaff(db, staff, (trx) =>
      callFn<{ changed: boolean }>(trx, "set_payment_reference", [paymentId, "SPEI-1"]),
    );
    expect(same.changed).toBe(false);
    const cleared = await withStaff(db, staff, (trx) =>
      callFn<{ changed: boolean; reference: string | null }>(trx, "set_payment_reference", [
        paymentId,
        "",
      ]),
    );
    expect(cleared).toMatchObject({ changed: true, reference: null });
  });

  it("rechaza referencias imposibles: más de 80 caracteres o caracteres de control", async () => {
    const { paymentId } = await paidOrder("SPEI-1");
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "set_payment_reference", [paymentId, "X".repeat(81)]),
      ),
    ).rejects.toThrow(/80 caracteres/);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "set_payment_reference", [paymentId, "SPEI\n<script>"]),
      ),
    ).rejects.toThrow(/letras, números y signos simples/);
    const r = await sql<{
      reference: string;
    }>`select reference from payments where id = ${paymentId}`.execute(db);
    expect(r.rows[0]!.reference).toBe("SPEI-1"); // nada se guardó a medias
  });

  it("falla claro si el pago no existe", async () => {
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "set_payment_reference", ["00000000-0000-0000-0000-000000000000", "SPEI-1"]),
      ),
    ).rejects.toThrow(/El pago no existe/);
  });
});

describe("histórico y búsqueda", () => {
  it("los pagos anteriores se quedan sin referencia: la migración no inventa valores", async () => {
    const order = await counterOrder();
    await pay(order, { provider: "manual", method: "transfer", amount_cents: 6000 });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from payments where reference is not null`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("la referencia lleva al pedido: ilike sobre payments.reference lo encuentra", async () => {
    const order = await counterOrder();
    await pay(order, {
      provider: "manual",
      method: "transfer",
      amount_cents: 6000,
      reference: "BANORTE-839201",
    });
    const r = await sql<{ folio: string }>`
      select o.folio from orders o
      where exists (select 1 from payments p where p.order_id = o.id and p.reference ilike ${"%banorte-839201%"})`.execute(
      db,
    );
    expect(r.rows).toHaveLength(1); // la búsqueda no distingue mayúsculas
  });

  it("el índice de referencia existe (búsqueda barata desde el buscador del CRM)", async () => {
    const r = await sql<{ indexname: string }>`
      select indexname from pg_indexes where tablename = 'payments' and indexname = 'payments_reference_trgm_idx'`.execute(
      db,
    );
    expect(r.rows).toHaveLength(1);
  });
});
