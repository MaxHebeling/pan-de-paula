/**
 * Editar los productos de un pedido — capa del CRM (base `${DATABASE_URL_TEST}_admin`).
 *
 * Lo que no se ve desde SQL: que la RUTA exige `orders.edit_items` y no le basta `orders.write`.
 * Max lo pidió así (2026-11-04): editar es de administración y gerencia; la cajera sigue pudiendo
 * AGREGAR en el mostrador, pero no quitar ni cambiar.
 *
 * `@/lib/auth` se simula: la sesión real vive en una cookie y aquí lo que se prueba es el permiso.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { adminTestDatabaseUrl } from "./db-url.ts";

const perms = new Set<string>();
let staffId = "";
let roleKey = "owner";

const fakeSession = () => ({
  staff: { id: staffId, fullName: "Test", roleKey, mustChangePassword: false },
  permissions: perms,
});

vi.mock("@/lib/auth", () => ({
  requireSession: async () => fakeSession(),
  getSession: async () => fakeSession(),
  hasPermission: (_s: unknown, p: string) => perms.has(p),
}));

type Ruta = typeof import("../app/api/pos/orders/[id]/items/route");
let PUT: Ruta["PUT"];
let POST: Ruta["POST"];
let db: Database;
let pool: { end: () => Promise<void> };
let product: string;

beforeAll(async () => {
  process.env.DATABASE_URL = adminTestDatabaseUrl();
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ PUT, POST } = await import("../app/api/pos/orders/[id]/items/route"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  await sql`truncate table order_item_edits, order_item_additions, payments, sales, order_status_history,
                       order_items, orders, product_prices, products, domain_events, audit_logs,
                       staff_users restart identity cascade`.execute(db);
  await sql`update business_settings set allow_negative_stock = true`.execute(db);
  perms.clear();
  const p = await sql<{ id: string }>`
    insert into products(name, slug, track_stock) values ('Concha', 'concha-edit', false) returning id`.execute(
    db,
  );
  product = p.rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents)
            values (${product}, 'all', 'regular', 3000)`.execute(db);
});

async function comoRol(role: string, permisos: string[]) {
  roleKey = role;
  const s = await sql<{ id: string }>`
    insert into staff_users(email, full_name, password_hash, role_key)
    values (${`${role}-${Math.random()}@pdp.local`}, 'Test', 'x', ${role}) returning id`.execute(
    db,
  );
  staffId = s.rows[0]!.id;
  for (const p of permisos) perms.add(p);
}

async function pedido() {
  const id = (
    await sql<{ id: string }>`select create_order(${JSON.stringify({
      channel: "web",
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [{ product_id: product, qty: 4 }],
    })}::jsonb) as id`.execute(db)
  ).rows[0]!.id;
  const item = (
    await sql<{ id: string }>`select id from order_items where order_id = ${id}`.execute(db)
  ).rows[0]!.id;
  return { id, item };
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const llamar = (fn: Handler, id: string, body: unknown, method = "PUT") =>
  fn(
    new Request(`http://x/api/pos/orders/${id}/items`, {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );

const total = async (id: string) =>
  (await sql<{ t: number }>`select total_cents as t from orders where id = ${id}`.execute(db))
    .rows[0]!.t;

describe("PUT /api/pos/orders/[id]/items — editar productos", () => {
  it("la cajera (orders.write) NO puede editar, pero sí sigue pudiendo agregar", async () => {
    await comoRol("cashier", ["orders.read", "orders.write", "pos.sell"]);
    const { id, item } = await pedido();

    const r = await llamar(PUT, id, {
      idempotency_key: "edit-caja-1",
      items: [{ order_item_id: item, qty: 1 }],
    });
    expect(r.status).toBe(403);
    expect(await total(id)).toBe(12000);

    const add = await llamar(
      POST,
      id,
      { idempotency_key: "add-caja-1", items: [{ product_id: product, qty: 1 }] },
      "POST",
    );
    expect(add.status).toBe(201);
    expect(await total(id)).toBe(15000);
  });

  it("la administradora edita: baja cantidades y el total se recalcula en el servidor", async () => {
    await comoRol("admin", ["orders.read", "orders.write", "orders.edit_items"]);
    const { id, item } = await pedido();

    const r = await llamar(PUT, id, {
      idempotency_key: "edit-admin-1",
      reason: "El cliente llamó",
      items: [{ order_item_id: item, qty: 1 }],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { total_cents: number; duplicate: boolean };
    expect(body).toMatchObject({ total_cents: 3000, duplicate: false });
    expect(await total(id)).toBe(3000);
  });

  it("rechaza una lista vacía antes de tocar la base", async () => {
    await comoRol("admin", ["orders.edit_items"]);
    const { id } = await pedido();
    const r = await llamar(PUT, id, { idempotency_key: "edit-vacio", items: [] });
    expect(r.status).toBe(400);
    expect(await total(id)).toBe(12000);
  });

  it("aunque la sesión trajera el permiso, la base rechaza a un rol que no lo tiene", async () => {
    // Defensa en profundidad: si un día la sesión se desalineara de la tabla de permisos, la regla
    // de quién puede editar sigue viviendo en `edit_order_items`.
    await comoRol("cashier", ["orders.edit_items"]);
    const { id, item } = await pedido();
    const r = await llamar(PUT, id, {
      idempotency_key: "edit-desalineado",
      items: [{ order_item_id: item, qty: 1 }],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await total(id)).toBe(12000);
  });
});
