/**
 * Referencia contable del pago — capa del CRM (base `${DATABASE_URL_TEST}_admin`).
 *
 * Cubre lo que no se ve desde SQL ni desde el navegador:
 *  - la server action que corrige la referencia exige permiso y deja rastro en auditoría;
 *  - el buscador global llega al PEDIDO pegando la referencia, y solo si el rol puede ver pedidos;
 *  - los filtros y la exportación de pagos traen la columna "Referencia" con el grano correcto
 *    (una fila por pago: método + monto + referencia sin mezclarse) y "—" en los pagos históricos.
 *
 * `@/lib/auth` se simula: la sesión real vive en una cookie y aquí lo que se prueba es el permiso.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { adminTestDatabaseUrl } from "./db-url.ts";

type Perms = Set<string>;
const perms: Perms = new Set<string>();
let staffId = "";

/** `redirect()` de Next lanza un error con digest NEXT_REDIRECT; requireSession hace eso al faltar el permiso. */
const redirectError = (to: string) =>
  Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });

const fakeSession = () => ({
  staff: { id: staffId, fullName: "Test", roleKey: "owner", mustChangePassword: false },
  permissions: perms,
});

vi.mock("@/lib/auth", () => ({
  requireSession: async (permission?: string) => {
    if (permission && !perms.has(permission)) throw redirectError("/403");
    return fakeSession();
  },
  getSession: async () => fakeSession(),
  hasPermission: (_s: unknown, p: string) => perms.has(p),
}));

type PedidosActions = typeof import("../app/(app)/pedidos/actions");
type Search = typeof import("../lib/search");
type Reports = typeof import("../lib/reports");

let updatePaymentReferenceAction: PedidosActions["updatePaymentReferenceAction"];
let paymentAction: PedidosActions["paymentAction"];
let globalSearch: Search["globalSearch"];
let searchScope: Search["searchScope"];
let exportRows: Reports["exportRows"];
let paymentsDetail: Reports["paymentsDetail"];
let toCsv: Reports["toCsv"];

let db: Database;
let pool: { end: () => Promise<void> };
let product: string;

const form = (f: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.set(k, v);
  return fd;
};

/** Venta de mostrador con los pagos que se le indiquen (misma función SQL que usa el POS). */
async function sell(payments: Array<Record<string, unknown>>, key: string) {
  const r = await sql<{ r: { order_id: string; folio: string } }>`
    select pos_checkout(${JSON.stringify({
      items: [{ product_id: product, qty: 2 }],
      idempotency_key: key,
      payments,
    })}::jsonb) as r`.execute(db);
  return r.rows[0]!.r;
}

const paymentIdsOf = async (orderId: string) =>
  (
    await sql<{
      id: string;
    }>`select id from payments where order_id = ${orderId} order by created_at`.execute(db)
  ).rows.map((x) => x.id);

const today = async () =>
  (
    await sql<{
      d: string;
    }>`select (now() at time zone (select timezone from business_settings where id=1))::date::text as d`.execute(
      db,
    )
  ).rows[0]!.d;

beforeAll(async () => {
  process.env.DATABASE_URL = adminTestDatabaseUrl();
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ updatePaymentReferenceAction, paymentAction } = await import("../app/(app)/pedidos/actions"));
  ({ globalSearch, searchScope } = await import("../lib/search"));
  ({ exportRows, paymentsDetail, toCsv } = await import("../lib/reports"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  await sql`truncate table refunds, returns, receipts, payments, sales, order_status_history, order_items, orders,
                       register_sessions, inventory_movements, inventory_levels, production_batches,
                       loyalty_transactions, customers, product_prices, products, categories,
                       domain_events, audit_logs, notifications, staff_users restart identity cascade`.execute(
    db,
  );
  await sql`update business_settings set allow_negative_stock = true`.execute(db);
  const s = await sql<{
    id: string;
  }>`insert into staff_users(email, full_name, password_hash, role_key) values ('caja@pdp.local','Caja','x','owner') returning id`.execute(
    db,
  );
  staffId = s.rows[0]!.id;
  const p = await sql<{
    id: string;
  }>`insert into products(name, slug, track_stock) values ('Concha','concha-ref', false) returning id`.execute(
    db,
  );
  product = p.rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${product}, 'all', 'regular', 3000)`.execute(
    db,
  );
  perms.clear();
  for (const x of [
    "orders.read",
    "orders.write",
    "customers.read",
    "catalog.read",
    "reports.read",
    "reports.export",
  ])
    perms.add(x);
});

describe("editar la referencia de un pago ya registrado", () => {
  it("un usuario autorizado la corrige y el cambio queda en auditoría", async () => {
    const sale = await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "BANORTE-48390" }],
      "edit-1",
    );
    const [paymentId] = await paymentIdsOf(sale.order_id);
    const r = await updatePaymentReferenceAction(
      {},
      form({ payment_id: paymentId!, reference: "BANORTE-483920" }),
    );
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain("BANORTE-483920");

    const stored = await sql<{
      reference: string;
    }>`select reference from payments where id = ${paymentId}`.execute(db);
    expect(stored.rows[0]!.reference).toBe("BANORTE-483920");

    const audit = await sql<{
      old_data: { reference: string | null };
      new_data: { reference: string | null };
      staff_id: string | null;
    }>`select old_data, new_data, staff_id from audit_logs
       where entity = 'payments' and action = 'UPDATE' and entity_id = ${paymentId}
       order by id desc limit 1`.execute(db);
    expect(audit.rows[0]).toMatchObject({ staff_id: staffId });
    expect(audit.rows[0]!.old_data.reference).toBe("BANORTE-48390");
    expect(audit.rows[0]!.new_data.reference).toBe("BANORTE-483920");
  });

  it("sin permiso orders.write la acción se rechaza y la referencia no cambia", async () => {
    const sale = await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "SPEI-ORIGINAL" }],
      "edit-2",
    );
    const [paymentId] = await paymentIdsOf(sale.order_id);
    perms.delete("orders.write");
    await expect(
      updatePaymentReferenceAction({}, form({ payment_id: paymentId!, reference: "HACKEADA" })),
    ).rejects.toMatchObject({ digest: expect.stringContaining("/403") });
    const stored = await sql<{
      reference: string;
    }>`select reference from payments where id = ${paymentId}`.execute(db);
    expect(stored.rows[0]!.reference).toBe("SPEI-ORIGINAL");
  });

  it("rechaza referencias fuera de forma sin tocar la base", async () => {
    const sale = await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "SPEI-OK" }],
      "edit-3",
    );
    const [paymentId] = await paymentIdsOf(sale.order_id);
    const tooLong = await updatePaymentReferenceAction(
      {},
      form({ payment_id: paymentId!, reference: "X".repeat(81) }),
    );
    expect(tooLong.error).toMatch(/80 caracteres/);
    const stored = await sql<{
      reference: string;
    }>`select reference from payments where id = ${paymentId}`.execute(db);
    expect(stored.rows[0]!.reference).toBe("SPEI-OK");
  });

  it("no toca el identificador del proveedor del pago", async () => {
    const sale = await sell([{ provider: "cash", method: "cash", amount_cents: 6000 }], "edit-4");
    const [paymentId] = await paymentIdsOf(sale.order_id);
    await sql`update payments set external_id = 'mp-777', provider = 'mercadopago' where id = ${paymentId}`.execute(
      db,
    );
    await updatePaymentReferenceAction(
      {},
      form({ payment_id: paymentId!, reference: "DEPOSITO-9" }),
    );
    const p = await sql<{
      external_id: string;
      reference: string;
    }>`select external_id, reference from payments where id = ${paymentId}`.execute(db);
    expect(p.rows[0]).toMatchObject({ external_id: "mp-777", reference: "DEPOSITO-9" });
  });

  it("no regresión: el cobro manual de un pedido sigue guardando la referencia al registrarse", async () => {
    const o = await sql<{ r: string }>`
      select create_order(${JSON.stringify({
        channel: "admin",
        fulfillment_type: "pickup",
        customer_name: "Manual",
        items: [{ product_id: product, qty: 1 }],
      })}::jsonb)::text as r`.execute(db);
    const orderId = o.rows[0]!.r;
    const res = await paymentAction(
      {},
      form({
        order_id: orderId,
        method: "transfer",
        amount: "30.00",
        reference: "MP-92847591",
        idempotency_key: "pay-manual-ref-1",
      }),
    );
    expect(res).toMatchObject({ ok: true });
    const p = await sql<{
      reference: string;
    }>`select reference from payments where order_id = ${orderId}`.execute(db);
    expect(p.rows[0]!.reference).toBe("MP-92847591");
  });
});

describe("búsqueda global por referencia", () => {
  it("pegar la referencia lleva al pedido donde se cobró", async () => {
    const sale = await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "BANORTE-839201" }],
      "search-1",
    );
    const r = await globalSearch("BANORTE-839201", 10, {
      customers: true,
      orders: true,
      products: true,
    });
    expect(r.orders.map((o) => o.folio)).toEqual([sale.folio]);
    expect(r.orders[0]!.payment_reference).toBe("BANORTE-839201");
  });

  it("no distingue mayúsculas ni exige la referencia completa", async () => {
    await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "BANORTE-839201" }],
      "search-2",
    );
    const r = await globalSearch("banorte-8392", 10, {
      customers: true,
      orders: true,
      products: true,
    });
    expect(r.orders).toHaveLength(1);
  });

  it("quien no puede ver pedidos NO recibe resultados por referencia", async () => {
    await sell(
      [{ provider: "manual", method: "transfer", amount_cents: 6000, reference: "BANORTE-839201" }],
      "search-3",
    );
    perms.delete("orders.read");
    const scope = searchScope((p) => perms.has(p));
    expect(scope.orders).toBe(false);
    const r = await globalSearch("BANORTE-839201", 10, scope);
    expect(r.orders).toEqual([]);
  });

  it("una venta con dos pagos solo aparece una vez y dice cuál referencia coincidió", async () => {
    await sell(
      [
        { provider: "manual", method: "transfer", amount_cents: 3000, reference: "SPEI-AAA" },
        { provider: "manual", method: "card_terminal", amount_cents: 3000, reference: "AUT-BBB" },
      ],
      "search-4",
    );
    const r = await globalSearch("AUT-BBB", 10, {
      customers: true,
      orders: true,
      products: true,
    });
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]!.payment_reference).toBe("AUT-BBB");
  });

  it("no regresión: buscar por folio sigue funcionando", async () => {
    const sale = await sell([{ provider: "cash", method: "cash", amount_cents: 6000 }], "search-5");
    const r = await globalSearch(sale.folio, 10, {
      customers: true,
      orders: true,
      products: true,
    });
    expect(r.orders.map((o) => o.folio)).toEqual([sale.folio]);
    expect(r.orders[0]!.payment_reference).toBeNull(); // coincidió por folio, no por referencia
  });
});

describe("reporte y exportación de pagos", () => {
  it("el CSV trae la columna Referencia con una fila por pago", async () => {
    const sale = await sell(
      [
        { provider: "manual", method: "transfer", amount_cents: 4000, reference: "SPEI-9001" },
        { provider: "manual", method: "card_terminal", amount_cents: 2000, reference: "AUT-4477" },
      ],
      "csv-1",
    );
    const d = await today();
    const data = await exportRows("pagos", d, d);
    expect(data.columns.map((c) => c.label)).toEqual([
      "Fecha",
      "Folio",
      "Cliente",
      "Método",
      "Referencia",
      "Monto (MXN)",
      "Reembolsado (MXN)",
      "Estado",
      "ID Mercado Pago",
      "Registró",
    ]);
    const csv = toCsv(data.columns, data.rows);
    // Cada parte del cobro dividido conserva su método, su monto y SU referencia en su propio renglón.
    expect(csv).toContain("Transferencia,SPEI-9001,40.00");
    expect(csv).toContain("Terminal,AUT-4477,20.00");
    expect(csv).toContain(sale.folio);
  });

  it("los pagos sin referencia exportan «—», no un valor inventado", async () => {
    await sell([{ provider: "cash", method: "cash", amount_cents: 6000 }], "csv-2");
    const d = await today();
    const data = await exportRows("pagos", d, d);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.reference_cell).toBe("—");
  });

  it("los filtros de método y referencia se aplican igual en pantalla y en el CSV", async () => {
    await sell(
      [
        { provider: "manual", method: "transfer", amount_cents: 4000, reference: "SPEI-9001" },
        { provider: "manual", method: "card_terminal", amount_cents: 2000, reference: "AUT-4477" },
      ],
      "csv-3",
    );
    const d = await today();
    expect(await paymentsDetail(d, d, { metodo: "transfer" })).toHaveLength(1);
    expect((await paymentsDetail(d, d, { ref: "AUT" }))[0]!.reference).toBe("AUT-4477");
    const filtered = await exportRows("pagos", d, d, { metodo: "card_terminal" });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]!.reference_cell).toBe("AUT-4477");
  });

  it("no regresión: los encabezados del reporte de canales siguen igual", async () => {
    const d = await today();
    const data = await exportRows("canales", d, d);
    expect(data.columns.map((c) => c.label)).toEqual([
      "Tipo",
      "Nombre",
      "Operaciones",
      "Monto (MXN)",
      "Reembolsado (MXN)",
    ]);
  });
});
