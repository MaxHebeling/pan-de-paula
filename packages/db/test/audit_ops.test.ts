/**
 * Auditoría OPERACIÓN (POS, caja, pedidos, producción, inventario, notificaciones).
 * Casos negativos, de borde y de concurrencia que no cubrían las suites existentes.
 * Cada `it` documenta la hipótesis auditada; los que reproducen bugs corregidos en 0013_audit_ops.sql
 * quedan como regresión.
 */
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { databaseUrl } from "../scripts/env.ts";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  onHand,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let pan: string;
let galleta: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  pan = await createProduct(db, "Pan audit", 10000);
  galleta = await createProduct(db, "Galleta audit", 2500);
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [pan, 20, null, null]));
  await withStaff(db, staff, (trx) => callFn(trx, "record_production", [galleta, 20, null, null]));
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Cliente pg crudo con identidad de staff, para simular una segunda pestaña/petición concurrente. */
async function rawClient() {
  const c = new pg.Client({ connectionString: databaseUrl("test") });
  await c.connect();
  return c;
}
const asStaff = (c: pg.Client) => c.query("select set_config('app.staff_id', $1, true)", [staff]);

async function customerBalance(id: string) {
  const r = await sql<{
    points_balance: number;
    total_spent_cents: string;
    total_orders: number;
  }>`select points_balance, total_spent_cents::text, total_orders from customers where id = ${id}::uuid`.execute(
    db,
  );
  return {
    points: r.rows[0]!.points_balance,
    spent: Number(r.rows[0]!.total_spent_cents),
    orders: r.rows[0]!.total_orders,
  };
}

// ── POS: pagos divididos ──────────────────────────────────────────────────────
describe("POS · pago dividido", () => {
  it("dos partes con el MISMO método y monto (p. ej. dos tarjetas de $50) concretan la venta", async () => {
    // Regresión: pos_checkout derivaba la idempotency_key de cada pago como idem:método:monto,
    // así que la segunda parte idéntica se trataba como duplicado y el pedido quedaba "partial" sin venta.
    const res = await posCheckout(db, staff, {
      idempotency_key: "pos-split-same",
      items: [{ product_id: pan, qty: 1 }],
      payments: [
        { provider: "manual", method: "card_terminal", amount_cents: 5000 },
        { provider: "manual", method: "card_terminal", amount_cents: 5000 },
      ],
    });
    expect(res.total_cents).toBe(10000);
    expect(res.paid_cents).toBe(10000);
    expect(res.sale_id).toBeTruthy();
    expect(res.status).toBe("completed");
    const pays = await sql<{ n: number }>`select count(*)::int as n from payments`.execute(db);
    expect(pays.rows[0]!.n).toBe(2);
    expect(await onHand(db, pan)).toBe(19);
  });

  it("efectivo + tarjeta: cambio solo sobre la parte en efectivo y venta completa", async () => {
    const res = await posCheckout(db, staff, {
      idempotency_key: "pos-split-mix",
      items: [{ product_id: pan, qty: 1 }],
      payments: [
        { provider: "cash", method: "cash", amount_cents: 4000, tendered_cents: 5000 },
        { provider: "manual", method: "transfer", amount_cents: 6000, reference: "SPEI-1" },
      ],
    });
    expect(res.change_cents).toBe(1000);
    expect(res.sale_id).toBeTruthy();
    // Reintento con la misma clave: no duplica pagos ni stock
    const again = await posCheckout(db, staff, {
      idempotency_key: "pos-split-mix",
      items: [{ product_id: pan, qty: 1 }],
      payments: [
        { provider: "cash", method: "cash", amount_cents: 4000, tendered_cents: 5000 },
        { provider: "manual", method: "transfer", amount_cents: 6000, reference: "SPEI-1" },
      ],
    });
    expect(again.duplicate).toBe(true);
    const pays = await sql<{ n: number }>`select count(*)::int as n from payments`.execute(db);
    expect(pays.rows[0]!.n).toBe(2);
    expect(await onHand(db, pan)).toBe(19);
  });

  it("la suma de partes que excede el total se rechaza completa (sin pedido huérfano)", async () => {
    await expect(
      posCheckout(db, staff, {
        items: [{ product_id: galleta, qty: 1 }],
        payments: [
          { provider: "manual", method: "card_terminal", amount_cents: 2000 },
          { provider: "manual", method: "transfer", amount_cents: 1000 },
        ],
      }),
    ).rejects.toThrow(/excede/);
    const n = await sql<{ n: number }>`select count(*)::int as n from orders`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("vender con una sesión de caja cerrada se rechaza", async () => {
    const session = await withStaff(db, staff, (trx) => callFn<string>(trx, "open_register", [0]));
    await withStaff(db, staff, (trx) => callFn(trx, "close_register", [session, 0]));
    await expect(
      posCheckout(db, staff, {
        register_session_id: session,
        items: [{ product_id: galleta, qty: 1 }],
        payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
      }),
    ).rejects.toThrow(/caja no está abierta/);
  });
});

// ── Concurrencia ─────────────────────────────────────────────────────────────
describe("concurrencia", () => {
  it("dos pestañas venden la última pieza con stock negativo prohibido: solo una gana", async () => {
    await sql`update business_settings set allow_negative_stock = false`.execute(db);
    const ultimo = await createProduct(db, "Último audit", 3000);
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [ultimo, 1, null, null]));
    const a = await rawClient();
    const b = await rawClient();
    try {
      // Pestaña A: transacción abierta (venta hecha, aún sin commit)
      await a.query("begin");
      await asStaff(a);
      await a.query("select pos_checkout($1::jsonb)", [
        JSON.stringify({
          idempotency_key: "race-a",
          items: [{ product_id: ultimo, qty: 1 }],
          payments: [{ provider: "manual", method: "card_terminal", amount_cents: 3000 }],
        }),
      ]);
      // Pestaña B: la misma pieza, en paralelo (se bloquea hasta que A confirme)
      const bRun = (async () => {
        await b.query("begin");
        await asStaff(b);
        try {
          await b.query("select pos_checkout($1::jsonb)", [
            JSON.stringify({
              idempotency_key: "race-b",
              items: [{ product_id: ultimo, qty: 1 }],
              payments: [{ provider: "manual", method: "card_terminal", amount_cents: 3000 }],
            }),
          ]);
          await b.query("commit");
          return "ok" as const;
        } catch (e) {
          await b.query("rollback");
          return (e as Error).message;
        }
      })();
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");
      const outcome = await bRun;
      expect(outcome).toMatch(/Stock insuficiente/);
      expect(await onHand(db, ultimo)).toBe(0);
      const sales = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
      expect(sales.rows[0]!.n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("dos peticiones simultáneas con la misma idempotency_key: una venta y la otra responde duplicate", async () => {
    const payload = {
      idempotency_key: "race-idem",
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 2500 }],
    };
    const a = await rawClient();
    const b = await rawClient();
    try {
      await a.query("begin");
      await asStaff(a);
      await a.query("select pos_checkout($1::jsonb)", [JSON.stringify(payload)]);
      const bRun = (async () => {
        await b.query("begin");
        await asStaff(b);
        const r = await b.query("select pos_checkout($1::jsonb) as r", [JSON.stringify(payload)]);
        await b.query("commit");
        return r.rows[0].r as Record<string, unknown>;
      })();
      await new Promise((r) => setTimeout(r, 200));
      await a.query("commit");
      const second = await bRun;
      expect(second.duplicate).toBe(true);
      expect(second.sale_id).toBeTruthy();
      const n = await sql<{ n: number }>`select count(*)::int as n from sales`.execute(db);
      expect(n.rows[0]!.n).toBe(1);
      expect(await onHand(db, galleta)).toBe(19);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("dos cierres de caja simultáneos: uno cierra, el otro recibe already_closed", async () => {
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [10000]),
    );
    const a = await rawClient();
    const b = await rawClient();
    try {
      await a.query("begin");
      await asStaff(a);
      await a.query("select close_register($1::uuid, 10000)", [session]);
      const bRun = (async () => {
        await b.query("begin");
        await asStaff(b);
        const r = await b.query("select close_register($1::uuid, 12345) as r", [session]);
        await b.query("commit");
        return r.rows[0].r as Record<string, unknown>;
      })();
      await new Promise((r) => setTimeout(r, 200));
      await a.query("commit");
      const second = await bRun;
      expect(second.already_closed).toBe(true);
      const rs = await sql<{
        counted_cash_cents: number;
        status: string;
      }>`select counted_cash_cents, status from register_sessions where id = ${session}::uuid`.execute(
        db,
      );
      expect(rs.rows[0]).toEqual({ counted_cash_cents: 10000, status: "closed" });
      const notif = await sql<{
        n: number;
      }>`select count(*)::int as n from notifications where kind = 'register_difference'`.execute(
        db,
      );
      expect(notif.rows[0]!.n).toBe(0);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("dos aperturas de caja simultáneas: solo una queda abierta", async () => {
    const a = await rawClient();
    const b = await rawClient();
    try {
      await a.query("begin");
      await asStaff(a);
      await a.query("select open_register(100)");
      const bRun = (async () => {
        await b.query("begin");
        await asStaff(b);
        try {
          await b.query("select open_register(200)");
          await b.query("commit");
          return "ok";
        } catch (e) {
          await b.query("rollback");
          return (e as { code?: string }).code ?? "err";
        }
      })();
      await new Promise((r) => setTimeout(r, 200));
      await a.query("commit");
      expect(await bRun).toBe("23505");
      const n = await sql<{
        n: number;
      }>`select count(*)::int as n from register_sessions where status = 'open'`.execute(db);
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("dos conteos físicos creados en paralelo: solo uno queda abierto", async () => {
    const a = await rawClient();
    const b = await rawClient();
    try {
      await a.query("begin");
      await asStaff(a);
      await a.query("select create_stock_count('A')");
      const bRun = (async () => {
        await b.query("begin");
        await asStaff(b);
        try {
          await b.query("select create_stock_count('B')");
          await b.query("commit");
          return "ok";
        } catch {
          await b.query("rollback");
          return "rejected";
        }
      })();
      await new Promise((r) => setTimeout(r, 200));
      await a.query("commit");
      await bRun;
      const n = await sql<{
        n: number;
      }>`select count(*)::int as n from stock_counts where status = 'open'`.execute(db);
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("doble envío de producción y de merma crea dos registros (el servidor no adivina): stock coherente", async () => {
    await Promise.all([
      withStaff(db, staff, (trx) => callFn(trx, "record_production", [galleta, 5, null, null])),
      withStaff(db, staff, (trx) => callFn(trx, "record_production", [galleta, 5, null, null])),
    ]);
    expect(await onHand(db, galleta)).toBe(30);
    await Promise.all([
      withStaff(db, staff, (trx) => callFn(trx, "record_waste", [galleta, 1, "burnt", null])),
      withStaff(db, staff, (trx) => callFn(trx, "record_waste", [galleta, 1, "burnt", null])),
    ]);
    expect(await onHand(db, galleta)).toBe(28);
    const rebuilt = await sql<{
      s: string;
    }>`select sum(qty)::text as s from inventory_movements where product_id = ${galleta}::uuid`.execute(
      db,
    );
    expect(Number(rebuilt.rows[0]!.s)).toBe(28);
  });
});

// ── Anulación y reembolsos ───────────────────────────────────────────────────
describe("anulación y reembolsos", () => {
  it("anular una venta con reembolso parcial previo revierte SOLO los puntos y el gasto restantes", async () => {
    // Regresión: void_sale revertía todos los puntos ganados y el total completo aunque ya se hubiera
    // reembolsado una parte (y con ella revertido puntos y gasto).
    const c = await createCustomer(db, "Ana Audit", "6641000001");
    const s1 = await posCheckout(db, staff, {
      idempotency_key: "v1",
      customer_id: c.customer_id,
      items: [{ product_id: pan, qty: 1 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 10000 }],
    });
    await posCheckout(db, staff, {
      idempotency_key: "v2",
      customer_id: c.customer_id,
      items: [{ product_id: pan, qty: 1 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 10000 }],
    });
    expect(await customerBalance(c.customer_id)).toEqual({ points: 20, spent: 20000, orders: 2 });
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${s1.order_id as string}::uuid`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: 5000, reason: "parcial" }),
      ]),
    );
    expect(await customerBalance(c.customer_id)).toEqual({ points: 15, spent: 15000, orders: 2 });
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [s1.sale_id, "error de captura"]));
    // Venta 2 intacta: 10 puntos, $100 gastados, 1 pedido
    expect(await customerBalance(c.customer_id)).toEqual({ points: 10, spent: 10000, orders: 1 });
    expect(await onHand(db, pan)).toBe(19);
    const ledger = await sql<{
      s: string;
    }>`select coalesce(sum(points),0)::text as s from loyalty_transactions where sale_id = ${s1.sale_id as string}::uuid`.execute(
      db,
    );
    expect(Number(ledger.rows[0]!.s)).toBe(0);
  });

  it("anular dos veces es idempotente y el pedido queda cancelado con motivo", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 5000, tendered_cents: 5000 }],
    });
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [r.sale_id, "cliente se fue"]));
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [r.sale_id, "otra vez"]));
    expect(await onHand(db, galleta)).toBe(20);
    const o = await sql<{
      status: string;
      cancel_reason: string;
      paid_cents: number;
    }>`select status, cancel_reason, paid_cents from orders where id = ${r.order_id as string}::uuid`.execute(
      db,
    );
    expect(o.rows[0]).toEqual({
      status: "cancelled",
      cancel_reason: "cliente se fue",
      paid_cents: 0,
    });
    const voids = await sql<{
      n: number;
    }>`select count(*)::int as n from inventory_movements where type = 'VOID'`.execute(db);
    expect(voids.rows[0]!.n).toBe(1);
  });

  it("reembolsar más de lo pagado, sobre un pago cancelado o con monto 0 se rechaza", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "manual", method: "transfer", amount_cents: 2500 }],
    });
    const pay = await sql<{
      id: string;
    }>`select id from payments where order_id = ${r.order_id as string}::uuid`.execute(db);
    const refund = (amount: number) =>
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_refund", [
          JSON.stringify({ payment_id: pay.rows[0]!.id, amount_cents: amount, reason: "x" }),
        ]),
      );
    await expect(refund(0)).rejects.toThrow(/inválido/);
    await expect(refund(2600)).rejects.toThrow(/inválido/);
    await refund(1500);
    await expect(refund(1500)).rejects.toThrow(/inválido/);
    await refund(1000);
    const o = await sql<{
      payment_status: string;
      status: string;
      refunded_cents: number;
    }>`select payment_status, status, refunded_cents from orders where id = ${r.order_id as string}::uuid`.execute(
      db,
    );
    expect(o.rows[0]).toEqual({
      payment_status: "refunded",
      status: "refunded",
      refunded_cents: 2500,
    });
    // Un pago totalmente reembolsado ya no admite más
    await expect(refund(1)).rejects.toThrow(/no es reembolsable/);
    // Anular después de reembolsar: los pagos ya no están "paid" → no hay dinero que cancelar, pero el stock regresa
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [r.sale_id, "post-reembolso"]));
    expect(await onHand(db, galleta)).toBe(20);
  });

  it("devolución física: valida pertenencia, cantidad acumulada y que exista venta; con restock reingresa stock", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 3 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 7500, tendered_cents: 7500 }],
    });
    const item = await sql<{
      id: string;
    }>`select id from order_items where order_id = ${r.order_id as string}::uuid`.execute(db);
    const ret = (qty: number, restock: boolean, extra: Record<string, unknown> = {}) =>
      withStaff(db, staff, (trx) =>
        callFn<string>(trx, "record_return", [
          JSON.stringify({
            order_id: r.order_id,
            order_item_id: item.rows[0]!.id,
            product_id: galleta,
            qty,
            restock,
            reason: "audit",
            ...extra,
          }),
        ]),
      );
    await expect(ret(0, true)).rejects.toThrow();
    await expect(ret(-1, true)).rejects.toThrow();
    await expect(ret(4, true)).rejects.toThrow(/vendieron|excede|cantidad/i);
    await ret(2, false);
    expect(await onHand(db, galleta)).toBe(17);
    await expect(ret(2, true)).rejects.toThrow(/vendieron|excede|cantidad/i); // 2 + 2 > 3
    await ret(1, true);
    expect(await onHand(db, galleta)).toBe(18);
    const mv = await sql<{
      n: number;
    }>`select count(*)::int as n from inventory_movements where type = 'RETURN' and ref_type = 'return'`.execute(
      db,
    );
    expect(mv.rows[0]!.n).toBe(1);
    // Un pedido sin venta (nunca pagado) no admite devolución
    const unpaid = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_order", [
        JSON.stringify({ channel: "admin", items: [{ product_id: galleta, qty: 1 }] }),
      ]),
    );
    const unpaidItem = await sql<{
      id: string;
    }>`select id from order_items where order_id = ${unpaid}::uuid`.execute(db);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_return", [
          JSON.stringify({
            order_id: unpaid,
            order_item_id: unpaidItem.rows[0]!.id,
            product_id: galleta,
            qty: 1,
            restock: true,
          }),
        ]),
      ),
    ).rejects.toThrow(/venta/i);
    // El renglón de otro pedido no se acepta
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_return", [
          JSON.stringify({
            order_id: r.order_id,
            order_item_id: unpaidItem.rows[0]!.id,
            product_id: galleta,
            qty: 1,
            restock: false,
          }),
        ]),
      ),
    ).rejects.toThrow(/pertenece/i);
  });
});

// ── Pagos y transiciones de pedidos ──────────────────────────────────────────
describe("pedidos · pagos y transiciones", () => {
  async function order(extra: Record<string, unknown> = {}) {
    return withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_order", [
        JSON.stringify({ channel: "admin", items: [{ product_id: pan, qty: 1 }], ...extra }),
      ]),
    );
  }
  const pay = (orderId: string, p: Record<string, unknown>) =>
    withStaff(db, staff, (trx) =>
      callFn<Record<string, unknown>>(trx, "record_payment", [
        JSON.stringify({ order_id: orderId, provider: "cash", method: "cash", ...p }),
      ]),
    );

  it("pago manual: efectivo recibido menor al monto, monto 0 y sobrepago se rechazan; parcial + resto concreta", async () => {
    const o = await order();
    await expect(pay(o, { amount_cents: 0 })).rejects.toThrow(/Monto inválido/);
    await expect(pay(o, { amount_cents: 5000, tendered_cents: 4000 })).rejects.toThrow(/menor/);
    await expect(pay(o, { amount_cents: 10001 })).rejects.toThrow(/excede/);
    const p1 = await pay(o, { amount_cents: 4000, tendered_cents: 5000, idempotency_key: "p1" });
    expect(p1.change_cents).toBe(1000);
    expect(p1.sale_id).toBeNull();
    const st = await sql<{
      payment_status: string;
      paid_cents: number;
    }>`select payment_status, paid_cents from orders where id = ${o}::uuid`.execute(db);
    expect(st.rows[0]).toEqual({ payment_status: "partial", paid_cents: 4000 });
    // Reintento del mismo pago: duplicado, no suma
    const dup = await pay(o, { amount_cents: 4000, tendered_cents: 5000, idempotency_key: "p1" });
    expect(dup.duplicate).toBe(true);
    await expect(pay(o, { amount_cents: 6001 })).rejects.toThrow(/excede/);
    const p2 = await pay(o, { amount_cents: 6000, idempotency_key: "p2" });
    expect(p2.sale_id).toBeTruthy();
    expect(await onHand(db, pan)).toBe(19);
    const o2 = await sql<{
      status: string;
      payment_status: string;
    }>`select status, payment_status from orders where id = ${o}::uuid`.execute(db);
    expect(o2.rows[0]).toEqual({ status: "paid", payment_status: "paid" });
  });

  it("transiciones inválidas por llamada directa se rechazan y no dejan historial", async () => {
    const o = await order();
    const go = (to: string, note: string | null = null) =>
      withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [o, to, note]));
    await expect(go("delivered")).rejects.toThrow(/Transición no permitida/);
    await expect(go("completed")).rejects.toThrow(/Transición no permitida/);
    await expect(go("refunded")).rejects.toThrow(/Transición no permitida/);
    await go("confirmed");
    await go("confirmed"); // idempotente
    await expect(go("new")).rejects.toThrow(/Transición no permitida/);
    await go("cancelled", "cliente canceló");
    await expect(go("confirmed")).rejects.toThrow(/Transición no permitida/);
    // Pagar un pedido cancelado se rechaza
    await expect(pay(o, { amount_cents: 10000 })).rejects.toThrow(/cancelado/);
    const h = await sql<{
      to_status: string;
      note: string | null;
    }>`select to_status, note from order_status_history where order_id = ${o}::uuid order by id`.execute(
      db,
    );
    expect(h.rows.map((r) => r.to_status)).toEqual(["new", "confirmed", "cancelled"]);
    expect(h.rows[2]!.note).toBe("cliente canceló");
  });

  it("cancelar un pedido que ya tiene venta se rechaza (hay que anular la venta)", async () => {
    const r = await posCheckout(db, staff, {
      items: [{ product_id: galleta, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 2500 }],
    });
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "change_order_status", [r.order_id, "cancelled", "x"]),
      ),
    ).rejects.toThrow(/Transición no permitida|anular venta/);
  });

  it("pedido manual con fecha en la zona del negocio y cupón; pago inicial parcial", async () => {
    await sql`insert into coupons(code, name, kind, value_bps) values ('DIEZ', '10%', 'pct', 1000)`.execute(
      db,
    );
    const c = await createCustomer(db, "Beto Audit", "6641000002");
    const sched = await sql<{ ts: string }>`
      select (('2026-09-15 18:00'::timestamp) at time zone (select timezone from business_settings where id = 1))::text as ts`.execute(
      db,
    );
    const o = await order({
      customer_id: c.customer_id,
      coupon_code: "diez",
      scheduled_for: sched.rows[0]!.ts,
      fulfillment_type: "scheduled_pickup",
    });
    const row = await sql<{
      total_cents: number;
      discount_cents: number;
      coupon_code: string;
      local: string;
      customer_name: string;
    }>`select total_cents, discount_cents, coupon_code, to_char(scheduled_for at time zone 'America/Tijuana', 'YYYY-MM-DD HH24:MI') as local, customer_name
       from orders where id = ${o}::uuid`.execute(db);
    expect(row.rows[0]).toEqual({
      total_cents: 9000,
      discount_cents: 1000,
      coupon_code: "DIEZ",
      local: "2026-09-15 18:00",
      customer_name: "Beto Audit",
    });
    const p = await pay(o, { amount_cents: 5000, method: "transfer", provider: "manual" });
    expect(p.sale_id).toBeNull();
    // El uso del cupón se registra hasta concretar la venta
    const uses = await sql<{ uses_count: number }>`select uses_count from coupons`.execute(db);
    expect(uses.rows[0]!.uses_count).toBe(0);
    await pay(o, { amount_cents: 4000, method: "transfer", provider: "manual" });
    const uses2 = await sql<{ uses_count: number }>`select uses_count from coupons`.execute(db);
    expect(uses2.rows[0]!.uses_count).toBe(1);
  });
});

// ── Cupones ──────────────────────────────────────────────────────────────────
describe("cupones · cada motivo de rechazo", () => {
  const validate = async (
    code: string,
    customer: string | null,
    subtotal: number,
    channel = "pos",
    items: unknown[] = [],
  ) => {
    const r = await sql<{
      v: { valid: boolean; reason?: string; discount_cents?: number };
    }>`select validate_coupon(${code}, ${customer}::uuid, ${subtotal}, ${channel}::price_channel, ${JSON.stringify(items)}::jsonb) as v`.execute(
      db,
    );
    return r.rows[0]!.v;
  };
  it("no existe, inactivo, expirado, no iniciado, agotado, canal, mínimo, límite por cliente, producto ausente", async () => {
    await sql`insert into coupons(code, kind, value_bps, is_active) values ('OFF', 'pct', 1000, false)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, ends_at) values ('VIEJO', 'pct', 1000, now() - interval '1 day')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, starts_at) values ('FUTURO', 'pct', 1000, now() + interval '1 day')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, max_uses, uses_count) values ('AGOTADO', 'amount', 500, 1, 1)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, channels) values ('SOLOWEB', 'pct', 1000, '{web}')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, min_subtotal_cents) values ('MIN', 'pct', 1000, 20000)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, max_uses_per_customer) values ('UNAVEZ', 'pct', 1000, 1)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, product_id) values ('GRATIS', 'free_product', ${pan}::uuid)`.execute(
      db,
    );
    expect((await validate("NOEXISTE", null, 10000)).reason).toBe("not_found");
    expect((await validate("OFF", null, 10000)).reason).toBe("inactive");
    expect((await validate("VIEJO", null, 10000)).reason).toBe("expired");
    expect((await validate("FUTURO", null, 10000)).reason).toBe("not_started");
    expect((await validate("AGOTADO", null, 10000)).reason).toBe("exhausted");
    expect((await validate("SOLOWEB", null, 10000)).reason).toBe("channel");
    expect((await validate("MIN", null, 10000)).reason).toBe("min_subtotal");
    expect((await validate("GRATIS", null, 10000)).reason).toBe("product_not_in_cart");
    expect(
      (
        await validate("GRATIS", null, 10000, "pos", [
          { product_id: pan, qty: 1, unit_price_cents: 10000, total_cents: 10000 },
        ])
      ).discount_cents,
    ).toBe(10000);
    const c = await createCustomer(db, "Cupón Audit", "6641000003");
    await posCheckout(db, staff, {
      customer_id: c.customer_id,
      coupon_code: "UNAVEZ",
      items: [{ product_id: pan, qty: 1 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 9000 }],
    });
    expect((await validate("UNAVEZ", c.customer_id, 10000)).reason).toBe("customer_limit");
    // Cobrar con un cupón inválido se rechaza completo (sin pedido)
    await expect(
      posCheckout(db, staff, {
        coupon_code: "VIEJO",
        items: [{ product_id: pan, qty: 1 }],
        payments: [{ provider: "manual", method: "card_terminal", amount_cents: 10000 }],
      }),
    ).rejects.toThrow(/Cupón inválido: expired/);
    const n = await sql<{ n: number }>`select count(*)::int as n from orders`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
  });
});

// ── Inventario ───────────────────────────────────────────────────────────────
describe("inventario", () => {
  it("movimientos, ledger de puntos y eventos son append-only por SQL directo", async () => {
    const mv = await sql<{ id: number }>`select id from inventory_movements limit 1`.execute(db);
    await expect(
      sql`update inventory_movements set qty = 999 where id = ${mv.rows[0]!.id}`.execute(db),
    ).rejects.toThrow(/solo inserción/);
    await expect(
      sql`delete from inventory_movements where id = ${mv.rows[0]!.id}`.execute(db),
    ).rejects.toThrow(/solo inserción/);
    await expect(sql`delete from domain_events`.execute(db)).rejects.toThrow(/solo inserción/);
    const c = await createCustomer(db, "Ledger", "6641000004");
    await withStaff(db, staff, (trx) => callFn(trx, "loyalty_post", [c.customer_id, "bonus", 5]));
    await expect(sql`update loyalty_transactions set points = 0`.execute(db)).rejects.toThrow(
      /solo inserción/,
    );
  });

  it("merma: cada motivo se mapea a su tipo de movimiento; 0, negativo y motivo inválido se rechazan; decimal se acepta", async () => {
    const waste = (qty: number, reason: string) =>
      withStaff(db, staff, (trx) => callFn(trx, "record_waste", [pan, qty, reason, null]));
    await expect(waste(0, "burnt")).rejects.toThrow(/Cantidad inválida/);
    await expect(waste(-1, "burnt")).rejects.toThrow(/Cantidad inválida/);
    await expect(waste(1, "no_existe")).rejects.toThrow();
    const reasons = [
      "burnt",
      "broken",
      "expired",
      "tasting",
      "gift",
      "courtesy",
      "internal_use",
      "error",
      "difference",
      "other",
    ];
    for (const r of reasons) await waste(0.5, r);
    expect(await onHand(db, pan)).toBe(15);
    const types = await sql<{
      reason: string;
      type: string;
    }>`select reason, type::text from inventory_movements where ref_type = 'waste_record' order by id`.execute(
      db,
    );
    const map = Object.fromEntries(types.rows.map((r) => [r.reason, r.type]));
    expect(map.gift).toBe("GIFT");
    expect(map.courtesy).toBe("GIFT");
    expect(map.internal_use).toBe("INTERNAL_USE");
    expect(map.burnt).toBe("WASTE");
    expect(map.difference).toBe("WASTE");
  });

  it("corrección manual: cero y motivo inválido se rechazan; producto inexistente se rechaza", async () => {
    const fix = (delta: number, reason: string) =>
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_stock_correction", [pan, delta, reason, null]),
      );
    await expect(fix(0, "error")).rejects.toThrow(/cero/);
    await expect(fix(1, "burnt")).rejects.toThrow(/Motivo/);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_stock_correction", [
          "00000000-0000-0000-0000-000000000000",
          1,
          "error",
          null,
        ]),
      ),
    ).rejects.toThrow(/no existe/);
    await fix(-2.5, "difference");
    expect(await onHand(db, pan)).toBe(17.5);
  });

  it("conteo: contado negativo rechazado, stock negativo se corrige, aplicar dos veces no duplica, cerrado no admite captura", async () => {
    await sql`update business_settings set allow_negative_stock = true`.execute(db);
    await withStaff(db, staff, (trx) => callFn(trx, "record_waste", [galleta, 25, "other", null]));
    expect(await onHand(db, galleta)).toBe(-5);
    const id = await withStaff(db, staff, (trx) => callFn<string>(trx, "create_stock_count", []));
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "set_stock_count_item", [id, galleta, -1, null])),
    ).rejects.toThrow(/inválida/);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "set_stock_count_item", [id, galleta, 3, null]),
    );
    const n = await withStaff(db, staff, (trx) => callFn<number>(trx, "apply_stock_count", [id]));
    expect(n).toBe(1);
    expect(await onHand(db, galleta)).toBe(3);
    const again = await withStaff(db, staff, (trx) =>
      callFn<number>(trx, "apply_stock_count", [id]),
    );
    expect(again).toBe(0);
    expect(await onHand(db, galleta)).toBe(3);
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "set_stock_count_item", [id, galleta, 9, null])),
    ).rejects.toThrow(/cerrado/);
    await withStaff(db, staff, (trx) => callFn(trx, "discard_stock_count", [id])); // no-op sobre aplicado
    const st = await sql<{ status: string }>`select status from stock_counts`.execute(db);
    expect(st.rows[0]!.status).toBe("applied");
  });

  it("conciliación: rangos que cruzan medianoche y fin de mes se cortan en la zona del negocio", async () => {
    // 23:30 del 31/ago y 00:10 del 1/sep, hora de Tijuana (UTC-7): en UTC ambos caen el 1 de septiembre.
    const prod = await createProduct(db, "TZ audit", 1000);
    const at = (local: string) =>
      sql<{ ts: string }>`select ((${local}::timestamp) at time zone 'America/Tijuana')::text as ts`
        .execute(db)
        .then((r) => r.rows[0]!.ts);
    const t1 = await at("2026-08-31 23:30");
    const t2 = await at("2026-09-01 00:10");
    const t3 = await at("2026-09-01 23:59");
    const t4 = await at("2026-09-02 00:01");
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [prod, 7, null, null, t1]),
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [prod, 5, null, null, t2]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "record_waste", [prod, 1, "burnt", null, t3]));
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [prod, 100, null, null, t4]),
    );
    const recon = async (desde: string, hasta: string) => {
      const r = await sql<{
        opening: string;
        production: string;
        waste: string;
        closing: string;
      }>`select opening::text, production::text, waste::text, closing::text
         from inventory_reconciliation(
           (${desde}::date)::timestamp at time zone (select timezone from business_settings where id = 1),
           ((${hasta}::date + 1)::timestamp) at time zone (select timezone from business_settings where id = 1))
         where product_id = ${prod}::uuid`.execute(db);
      const x = r.rows[0]!;
      return {
        opening: Number(x.opening),
        production: Number(x.production),
        waste: Number(x.waste),
        closing: Number(x.closing),
      };
    };
    expect(await recon("2026-09-01", "2026-09-01")).toEqual({
      opening: 7,
      production: 5,
      waste: 1,
      closing: 11,
    });
    expect(await recon("2026-08-01", "2026-08-31")).toEqual({
      opening: 0,
      production: 7,
      waste: 0,
      closing: 7,
    });
    expect(await recon("2026-09-02", "2026-09-02")).toEqual({
      opening: 11,
      production: 100,
      waste: 0,
      closing: 111,
    });
  });

  it("rebuild_inventory_levels repara un nivel materializado alterado", async () => {
    await sql`update inventory_levels set on_hand = 999 where product_id = ${pan}::uuid`.execute(
      db,
    );
    await sql`select rebuild_inventory_levels()`.execute(db);
    expect(await onHand(db, pan)).toBe(20);
  });
});

// ── Producción ───────────────────────────────────────────────────────────────
describe("producción", () => {
  it("consumo de insumos: apagado por flag no descuenta; forzado por parámetro sí; deshacer los devuelve; alerta de insumo crítico", async () => {
    const ing = await sql<{
      id: string;
    }>`insert into ingredients(name, base_unit, min_stock_qty, stock_qty) values ('Harina audit', 'g', 500, 1000) returning id`.execute(
      db,
    );
    const rec = await sql<{
      id: string;
    }>`insert into recipes(product_id, yield_qty) values (${pan}::uuid, 10) returning id`.execute(
      db,
    );
    await sql`insert into recipe_items(recipe_id, ingredient_id, qty) values (${rec.rows[0]!.id}::uuid, ${ing.rows[0]!.id}::uuid, 1000)`.execute(
      db,
    );
    const stock = async () =>
      Number(
        (
          await sql<{
            s: string;
          }>`select stock_qty::text as s from ingredients where id = ${ing.rows[0]!.id}::uuid`.execute(
            db,
          )
        ).rows[0]!.s,
      );
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [pan, 10, null, null]));
    expect(await stock()).toBe(1000); // flag apagado
    const batch = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "record_production", [pan, 6, null, true]),
    );
    expect(await stock()).toBe(400); // 6/10 × 1000
    const alert = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind = 'ingredient_low' and read_at is null`.execute(
      db,
    );
    expect(alert.rows[0]!.n).toBe(1);
    await withStaff(db, staff, (trx) => callFn(trx, "undo_production", [batch, "x"]));
    expect(await stock()).toBe(1000);
    expect(await onHand(db, pan)).toBe(30);
  });

  it("producción: 0, negativa y producto inexistente se rechazan; deshacer fuera de ventana se rechaza", async () => {
    const prod = (qty: number) =>
      withStaff(db, staff, (trx) =>
        callFn<string>(trx, "record_production", [pan, qty, null, null]),
      );
    await expect(prod(0)).rejects.toThrow(/Cantidad inválida/);
    await expect(prod(-3)).rejects.toThrow(/Cantidad inválida/);
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "record_production", ["00000000-0000-0000-0000-000000000000", 1, null, null]),
      ),
    ).rejects.toThrow(/no existe/);
    const b = await prod(4);
    await sql`update production_batches set created_at = now() - interval '3 minutes' where id = ${b}::uuid`.execute(
      db,
    );
    await expect(
      withStaff(db, staff, (trx) => callFn(trx, "undo_production", [b, "tarde"])),
    ).rejects.toThrow(/2 minutos/);
    expect(await onHand(db, pan)).toBe(24);
  });

  it("producción sugerida: con pedidos comprometidos y sin ellos; excluye cancelados/completados", async () => {
    const sched = await sql<{ ts: string }>`
      select (('2026-10-05 10:00'::timestamp) at time zone (select timezone from business_settings where id = 1))::text as ts`.execute(
      db,
    );
    const mk = (qty: number) =>
      withStaff(db, staff, (trx) =>
        callFn<string>(trx, "create_order", [
          JSON.stringify({
            channel: "admin",
            fulfillment_type: "scheduled_pickup",
            scheduled_for: sched.rows[0]!.ts,
            items: [{ product_id: pan, qty }],
          }),
        ]),
      );
    const o1 = await mk(30);
    const o2 = await mk(8);
    await withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [o2, "cancelled", "x"]));
    const row = async () =>
      (
        await sql<{
          committed_qty: string;
          on_hand: string;
          suggested_qty: string;
        }>`select committed_qty::text, on_hand::text, suggested_qty::text from suggested_production('2026-10-05'::date) where product_id = ${pan}::uuid`.execute(
          db,
        )
      ).rows[0]!;
    let r = await row();
    expect(Number(r.committed_qty)).toBe(30);
    expect(Number(r.on_hand)).toBe(20);
    expect(Number(r.suggested_qty)).toBe(10);
    // Sin pedidos comprometidos (otra fecha) → 0 sugerido
    const empty = await sql<{
      suggested_qty: string;
      committed_qty: string;
    }>`select suggested_qty::text, committed_qty::text from suggested_production('2026-10-06'::date) where product_id = ${pan}::uuid`.execute(
      db,
    );
    expect(Number(empty.rows[0]!.committed_qty)).toBe(0);
    expect(Number(empty.rows[0]!.suggested_qty)).toBe(0);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: o1,
          provider: "manual",
          method: "transfer",
          amount_cents: 300000,
        }),
      ]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "change_order_status", [o1, "completed"]));
    r = await row();
    expect(Number(r.committed_qty)).toBe(0);
  });
});

// ── Notificaciones ───────────────────────────────────────────────────────────
describe("notificaciones por eventos", () => {
  it("stock bajo → agotado (sin duplicar), pago rechazado, diferencia de caja y nuevo VIP", async () => {
    await sql`update business_settings set low_stock_threshold = 3`.execute(db);
    const poco = await createProduct(db, "Poco audit", 1000);
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [poco, 4, null, null]));
    const sell = (qty: number) =>
      posCheckout(db, staff, {
        items: [{ product_id: poco, qty }],
        payments: [{ provider: "manual", method: "card_terminal", amount_cents: 1000 * qty }],
      });
    await sell(1); // quedan 3 → low_stock
    await sell(1); // quedan 2 → ya hay una abierta: no duplica
    const kinds = async () =>
      (
        await sql<{
          kind: string;
          read_at: Date | null;
        }>`select kind, read_at from notifications where entity_id = ${poco} order by created_at`.execute(
          db,
        )
      ).rows;
    expect((await kinds()).map((k) => k.kind)).toEqual(["low_stock"]);
    await sell(2); // quedan 0 → sigue abierta la de low_stock: finalize_sale no la sube; el cron la promueve
    expect((await kinds()).filter((k) => !k.read_at).length).toBe(1);
    const cron = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(cron.upgraded).toBe(1);
    expect(cron.out_of_stock).toBe(1);
    const open = (await kinds()).filter((k) => !k.read_at);
    expect(open.map((k) => k.kind)).toEqual(["out_of_stock"]);
    // Reponer cierra la alerta
    await withStaff(db, staff, (trx) => callFn(trx, "record_production", [poco, 10, null, null]));
    expect((await kinds()).filter((k) => !k.read_at).length).toBe(0);
    // Segunda corrida del cron: idempotente
    const cron2 = await callFn<Record<string, number>>(db, "run_stock_alerts", []);
    expect(cron2).toMatchObject({ low_stock: 0, out_of_stock: 0, ingredient_low: 0 });

    // Pago rechazado
    const o = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "create_order", [
        JSON.stringify({ channel: "web", items: [{ product_id: pan, qty: 1 }] }),
      ]),
    );
    await sql`update products set show_on_web = true where id = ${pan}::uuid`.execute(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_payment", [
        JSON.stringify({
          order_id: o,
          provider: "mercadopago",
          method: "mercadopago",
          amount_cents: 10000,
          status: "failed",
          external_id: "mp-fail-1",
        }),
      ]),
    );
    const failed = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind = 'payment_failed' and entity_id = ${o}`.execute(
      db,
    );
    expect(failed.rows[0]!.n).toBe(1);

    // Diferencia de caja
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [5000]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "close_register", [session, 4000]));
    const diff = await sql<{
      body: string;
    }>`select body from notifications where kind = 'register_difference' and entity_id = ${session}`.execute(
      db,
    );
    expect(diff.rows[0]!.body).toContain("Esperado $50.00");
    expect(diff.rows[0]!.body).toContain("Contado $40.00");

    // Nuevo VIP: umbral bajado para la prueba (loyalty_tiers no se trunca: se restaura al final)
    await sql`update loyalty_tiers set min_orders = 1, min_spent_cents = 0 where key = 'vip'`.execute(
      db,
    );
    await sql`update loyalty_tiers set min_orders = 0, min_spent_cents = 0 where key = 'frequent'`.execute(
      db,
    );
    try {
      const c = await createCustomer(db, "Vip Audit", "6641000005");
      await posCheckout(db, staff, {
        customer_id: c.customer_id,
        items: [{ product_id: pan, qty: 1 }],
        payments: [{ provider: "manual", method: "card_terminal", amount_cents: 10000 }],
      });
      const vip = await sql<{
        n: number;
      }>`select count(*)::int as n from notifications where kind = 'new_vip' and entity_id = ${c.customer_id}`.execute(
        db,
      );
      expect(vip.rows[0]!.n).toBe(1);
    } finally {
      await sql`update loyalty_tiers set min_orders = 15, min_spent_cents = 500000 where key = 'vip'`.execute(
        db,
      );
      await sql`update loyalty_tiers set min_orders = 5, min_spent_cents = 150000 where key = 'frequent'`.execute(
        db,
      );
    }
  });
});

// ── Caja ─────────────────────────────────────────────────────────────────────
describe("caja", () => {
  it("resumen de una sesión cerrada conserva el esperado congelado aunque después se anule una venta en efectivo", async () => {
    const session = await withStaff(db, staff, (trx) =>
      callFn<string>(trx, "open_register", [10000]),
    );
    const r = await posCheckout(db, staff, {
      register_session_id: session,
      items: [{ product_id: galleta, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 5000, tendered_cents: 5000 }],
    });
    const closed = await withStaff(db, staff, (trx) =>
      callFn<Record<string, number>>(trx, "close_register", [session, 15000]),
    );
    expect(closed.expected_cash_cents).toBe(15000);
    expect(closed.difference_cents).toBe(0);
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [r.sale_id, "después del corte"]));
    const summary = await callFn<Record<string, number>>(db, "register_session_summary", [session]);
    expect(summary.counted_cash_cents).toBe(15000);
    expect(summary.difference_cents).toBe(0);
    // Lo que la pantalla /caja/[id] y el corte impreso deben mostrar como esperado: el valor al cierre.
    const stored = await sql<{
      expected_cash_cents: number;
    }>`select expected_cash_cents from register_sessions where id = ${session}::uuid`.execute(db);
    expect(stored.rows[0]!.expected_cash_cents).toBe(15000);
    expect(summary.voided_count).toBe(1);
  });
});
