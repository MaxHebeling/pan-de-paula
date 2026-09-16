/**
 * Revalidación del carrito contra Postgres real (base `${DATABASE_URL_TEST}_web`).
 * Cubre: precio cambiado en `product_prices` entre dos llamadas, promoción vigente, producto retirado
 * de la web, producto agotado sin preventa, carrito vacío / ids inválidos, seguridad frente a precios
 * manipulados desde el cliente, auditoría del cambio de precio y foto del precio pagado en pedidos previos.
 * `next/headers` se simula para fijar la IP del rate limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { addDays, localNow, weekdayOf } from "@pdp/domain";
import { webTestDatabaseUrl } from "./db-url.ts";
import { reconcileCart } from "../lib/cart/reconcile.ts";
import type { CartLine } from "../lib/cart/types.ts";

let ip = "203.0.113.20";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip }),
}));

type CartActions = typeof import("../app/carrito/actions");
type CheckoutActions = typeof import("../app/checkout/actions");
let revalidateCartAction: CartActions["revalidateCartAction"];
let placeOrderAction: CheckoutActions["placeOrderAction"];
let db: Database;
let pool: { end: () => Promise<void> };

const TZ = "America/Tijuana";
let windowId: string;
let date: string;
let croissant: string;

async function product(
  name: string,
  priceCents: number,
  opts: { showOnWeb?: boolean; allowPreorder?: boolean; trackStock?: boolean } = {},
) {
  const slug = `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await sql<{ id: string }>`
    insert into products(name, slug, track_stock, show_on_web, is_active, allow_preorder)
    values (${name}, ${slug}, ${opts.trackStock ?? true}, ${opts.showOnWeb ?? true}, true, ${opts.allowPreorder ?? true})
    returning id`.execute(db);
  const id = r.rows[0]!.id;
  await sql`select set_regular_price(${id}, 'web'::price_channel, ${priceCents}, 'alta')`.execute(
    db,
  );
  return id;
}

/** Línea de carrito tal como la guardaría el navegador al agregar el producto. */
const line = (productId: string, unitPriceCents: number, qty = 2): CartLine => ({
  productId,
  slug: "croissant-dubai",
  name: "Croissant Dubai",
  variantLabel: null,
  unitPriceCents,
  qty,
  imageUrl: null,
  categorySlug: null,
});

/** Revalida y reconcilia como lo hace el navegador: manda solo product_id y qty. */
async function syncCart(lines: CartLine[]) {
  const r = await revalidateCartAction(lines.map((l) => ({ product_id: l.productId, qty: l.qty })));
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return { products: r.products, ...reconcileCart(lines, r.products) };
}

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3113";
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  delete process.env.RESEND_API_KEY;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ revalidateCartAction } = await import("../app/carrito/actions"));
  ({ placeOrderAction } = await import("../app/checkout/actions"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await pool.end().catch(() => {});
});

beforeEach(async () => {
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  await sql`truncate table refunds, returns, receipts, payments, sales, order_status_history, order_items, orders,
    inventory_movements, inventory_levels, loyalty_transactions, coupon_redemptions, coupons, customer_events, customers,
    product_prices, product_images, products, categories, rate_limits, ordering_windows, pickup_points, calendar_exceptions,
    domain_events, audit_logs, notifications restart identity cascade`.execute(db);
  await sql`update feature_flags set enabled = (key = 'web_checkout') where key in ('web_checkout','mercadopago_online')`.execute(
    db,
  );
  await sql`update business_settings set policies = '{}'::jsonb, timezone = ${TZ}, prices_include_tax = true, tax_rate_bps = 0 where id = 1`.execute(
    db,
  );
  const now = localNow(new Date(), TZ);
  date = addDays(now.date, 1);
  windowId = (
    await sql<{ id: string }>`
      insert into ordering_windows(name, fulfillment_type, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, lead_days_min)
      values ('Ventana de prueba', 'scheduled_pickup', '{0,1,2,3,4,5,6}', '23:59', ${weekdayOf(date)}, '10:00', '18:00', 1) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into pickup_points(name, address, is_default) values ('Mostrador', 'Calle 1', true)`.execute(
    db,
  );
  croissant = await product("Croissant Dubai", 11500);
  await sql`insert into inventory_levels(product_id, on_hand) values (${croissant}, 40)`.execute(
    db,
  );
});

describe("revalidación del carrito · precios del servidor", () => {
  it("carrito al día: devuelve el precio vigente y no reporta cambios", async () => {
    const r = await syncCart([line(croissant, 11500)]);
    expect(r.products).toHaveLength(1);
    expect(r.products[0]).toMatchObject({
      productId: croissant,
      name: "Croissant Dubai",
      unitPriceCents: 11500,
      canAdd: true,
      soldOut: false,
    });
    expect(r.changes).toEqual([]);
  });

  it("precio cambiado entre dos llamadas: la segunda trae el vigente y avisa del cambio", async () => {
    const carrito = [line(croissant, 11500)];
    expect((await syncCart(carrito)).changes).toEqual([]);

    // Administración sube el precio web (mismo camino que usa el CRM: set_regular_price).
    await sql`select set_regular_price(${croissant}, 'web'::price_channel, 12000, 'Ajuste')`.execute(
      db,
    );

    const r = await syncCart(carrito);
    expect(r.products[0]!.unitPriceCents).toBe(12000);
    expect(r.lines[0]!.unitPriceCents).toBe(12000);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ kind: "precio_subio", fromCents: 11500, toCents: 12000 });
    expect(r.changes[0]!.message).toContain("$115.00");
    expect(r.changes[0]!.message).toContain("$120.00");
  });

  it("promoción vigente en web: el carrito toma el precio promocional y avisa que bajó", async () => {
    await sql`select create_promotion(${croissant}, 'web'::price_channel, 9900, now() - interval '1 minute', now() + interval '1 day', 'Promo')`.execute(
      db,
    );
    const r = await syncCart([line(croissant, 11500)]);
    expect(r.products[0]!.unitPriceCents).toBe(9900);
    expect(r.changes[0]).toMatchObject({ kind: "precio_bajo", toCents: 9900 });
  });

  it("producto retirado de la web (o sin precio web) desaparece de la respuesta y del carrito", async () => {
    await sql`update products set show_on_web = false where id = ${croissant}`.execute(db);
    const r = await syncCart([line(croissant, 11500)]);
    expect(r.products).toEqual([]);
    expect(r.lines).toEqual([]);
    expect(r.changes[0]).toMatchObject({ kind: "retirado" });
  });

  it("producto agotado sin preventa vuelve marcado y se quita del carrito con su motivo", async () => {
    const agotado = await product("Rosca", 8000, { allowPreorder: false });
    const r = await syncCart([{ ...line(agotado, 8000), name: "Rosca" }]);
    expect(r.products[0]).toMatchObject({ canAdd: false, soldOut: true });
    expect(r.products[0]!.note).toMatch(/no hay piezas/i);
    expect(r.lines).toEqual([]);
    expect(r.changes[0]).toMatchObject({ kind: "agotado", name: "Rosca" });
  });

  it("carrito vacío o ids inválidos: respuesta vacía sin errores", async () => {
    expect(await revalidateCartAction([])).toEqual({ ok: true, products: [] });
    expect(
      await revalidateCartAction([
        { product_id: "no-es-uuid", qty: 1 },
        { product_id: "'; drop table products; --", qty: 1 },
      ]),
    ).toEqual({ ok: true, products: [] });
    expect(await revalidateCartAction([{ product_id: crypto.randomUUID(), qty: 1 }])).toEqual({
      ok: true,
      products: [],
    });
    // La tabla sigue ahí
    expect(
      (await sql`select 1 from products where id = ${croissant}`.execute(db)).rows,
    ).toHaveLength(1);
  });
});

describe("revalidación del carrito · seguridad", () => {
  it("un precio manipulado desde el cliente no cambia la respuesta del servidor", async () => {
    const manipulado = [
      {
        product_id: croissant,
        qty: 2,
        unit_price_cents: 1,
        unitPriceCents: 1,
        price: 0,
        name: "Gratis",
      },
    ] as unknown as Parameters<CartActions["revalidateCartAction"]>[0];
    const r = await revalidateCartAction(manipulado);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.products[0]).toMatchObject({ unitPriceCents: 11500, name: "Croissant Dubai" });
  });

  it("un precio manipulado en el checkout se ignora: el pedido se crea con el precio vigente", async () => {
    const payload = {
      items: [{ product_id: croissant, qty: 2, unit_price_cents: 1, total_cents: 2 }],
      window_id: windowId,
      date,
      customer_name: "Prueba Web",
      customer_phone: "6649876543",
      payment_method: "cash" as const,
      marketing_consent: false,
      idempotency_key: `web-${crypto.randomUUID()}`,
    } as unknown as Parameters<CheckoutActions["placeOrderAction"]>[0];
    const r = await placeOrderAction(payload);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const o = await sql<{ subtotal_cents: number; total_cents: number }>`
      select subtotal_cents, total_cents from orders order by created_at desc limit 1`.execute(db);
    expect(o.rows[0]).toMatchObject({ subtotal_cents: 23000, total_cents: 23000 });
    const items = await sql<{ unit_price_cents: number }>`
      select unit_price_cents from order_items`.execute(db);
    expect(items.rows.map((i) => i.unit_price_cents)).toEqual([11500]);
  });
});

describe("revalidación del carrito · histórico y auditoría", () => {
  it("una compra anterior conserva el precio pagado aunque después cambie el precio", async () => {
    const r = await placeOrderAction({
      items: [{ product_id: croissant, qty: 2 }],
      window_id: windowId,
      date,
      customer_name: "Prueba Web",
      customer_phone: "6649876543",
      payment_method: "cash",
      marketing_consent: false,
      idempotency_key: `web-${crypto.randomUUID()}`,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    await sql`select set_regular_price(${croissant}, 'web'::price_channel, 12000, 'Ajuste')`.execute(
      db,
    );

    const items = await sql<{ unit_price_cents: number; total_cents: number }>`
      select unit_price_cents, total_cents from order_items`.execute(db);
    expect(items.rows).toEqual([{ unit_price_cents: 11500, total_cents: 23000 }]);
    const o = await sql<{ subtotal_cents: number; total_cents: number }>`
      select subtotal_cents, total_cents from orders`.execute(db);
    expect(o.rows[0]).toMatchObject({ subtotal_cents: 23000, total_cents: 23000 });
    // El carrito nuevo sí ve el precio nuevo
    expect((await syncCart([line(croissant, 11500)])).lines[0]!.unitPriceCents).toBe(12000);
  });

  it("cada cambio de precio queda en audit_logs (trigger de product_prices, ya existente)", async () => {
    const before = await sql<{ n: string }>`
      select count(*) as n from audit_logs where entity = 'product_prices'`.execute(db);
    await sql`select set_regular_price(${croissant}, 'web'::price_channel, 12000, 'Ajuste')`.execute(
      db,
    );
    const after = await sql<{ action: string; new_price: number | null; old_to: string | null }>`
      select action, (new_data->>'price_cents')::int as new_price, old_data->>'valid_to' as old_to
        from audit_logs where entity = 'product_prices' order by id`.execute(db);
    // Cierre del precio anterior (UPDATE con valid_to) + alta del nuevo (INSERT con el precio nuevo)
    expect(after.rows.length).toBe(Number(before.rows[0]!.n) + 2);
    const ultimos = after.rows.slice(-2);
    expect(ultimos.map((r) => r.action)).toEqual(["UPDATE", "INSERT"]);
    expect(ultimos[1]!.new_price).toBe(12000);
  });
});
