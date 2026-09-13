/**
 * Auditoría del checkout web contra Postgres real (base `${DATABASE_URL_TEST}_web`).
 * Cubre: flag apagado, fecha/ventana inválida, teléfonos (9/10/11 dígitos, +52), correo, nombre Unicode,
 * productos no vendibles, métodos de pago según configuración, cupones, precios del servidor,
 * idempotencia (replay y carrera), vínculo de cliente, comprobante sin Resend y rate limit (21.ª petición).
 * `next/headers` se simula para fijar la IP del rate limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { addDays, localNow, weekdayOf } from "@pdp/domain";
import { webTestDatabaseUrl } from "./db-url.ts";
import { zonedToUtc } from "../lib/tz.ts";

let ip = "203.0.113.10";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip }),
}));

type Actions = typeof import("../app/checkout/actions");
type CartActions = typeof import("../app/carrito/actions");
let placeOrderAction: Actions["placeOrderAction"];
let lookupCustomerAction: Actions["lookupCustomerAction"];
let validateCouponAction: CartActions["validateCouponAction"];
let db: Database;
let pool: { end: () => Promise<void> };

const TZ = "America/Tijuana";
let windowId: string;
let date: string;
let concha: string;
let croissant: string;
let soloPos: string;
let inactivo: string;
let agotado: string;
let sinPrecioWeb: string;
let ana: { customer_id: string; public_code: string; qr_token: string };

async function product(
  name: string,
  price: number,
  opts: {
    channel?: "all" | "web" | "pos";
    showOnWeb?: boolean;
    active?: boolean;
    allowPreorder?: boolean;
  } = {},
) {
  const slug = `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await sql<{
    id: string;
  }>`insert into products(name, slug, track_stock, show_on_web, is_active, allow_preorder)
    values (${name}, ${slug}, true, ${opts.showOnWeb ?? true}, ${opts.active ?? true}, ${opts.allowPreorder ?? true}) returning id`.execute(
    db,
  );
  const id = r.rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${id}, ${opts.channel ?? "all"}::price_channel, 'regular', ${price})`.execute(
    db,
  );
  return id;
}

const base = (over: Partial<Parameters<Actions["placeOrderAction"]>[0]> = {}) => ({
  items: [{ product_id: concha, qty: 2 }],
  window_id: windowId,
  date,
  customer_name: "Prueba Web",
  customer_phone: "6649876543",
  payment_method: "cash" as const,
  marketing_consent: false,
  idempotency_key: `web-${crypto.randomUUID()}`,
  ...over,
});

const orderCount = async () =>
  Number((await sql<{ n: string }>`select count(*) as n from orders`.execute(db)).rows[0]!.n);

async function orderFromRedirect(redirect: string) {
  const u = new URL(redirect);
  const folio = decodeURIComponent(u.pathname.split("/").pop()!);
  const token = u.searchParams.get("t")!;
  const r = await sql<{
    id: string;
    status: string;
    payment_status: string;
    customer_id: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    subtotal_cents: number;
    discount_cents: number;
    total_cents: number;
    coupon_code: string | null;
    scheduled_for: Date;
    public_token: string;
    internal_notes: string | null;
  }>`select id, status, payment_status, customer_id, customer_phone, customer_email, subtotal_cents, discount_cents,
            total_cents, coupon_code, scheduled_for, public_token, internal_notes from orders where folio = ${folio}`.execute(
    db,
  );
  expect(r.rows[0]?.public_token).toBe(token);
  return { folio, token, u, ...r.rows[0]! };
}

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3113";
  delete process.env.MERCADOPAGO_ACCESS_TOKEN;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ placeOrderAction, lookupCustomerAction } = await import("../app/checkout/actions"));
  ({ validateCouponAction } = await import("../app/carrito/actions"));
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
  await sql`update feature_flags set enabled = (key = 'web_checkout' or key = 'loyalty')
            where key in ('web_checkout','mercadopago_online','loyalty')`.execute(db);
  await sql`update business_settings set policies = '{}'::jsonb, timezone = ${TZ}, prices_include_tax = true, tax_rate_bps = 0 where id = 1`.execute(
    db,
  );
  const now = localNow(new Date(), TZ);
  date = addDays(now.date, 1);
  windowId = (
    await sql<{
      id: string;
    }>`insert into ordering_windows(name, fulfillment_type, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, lead_days_min)
      values ('Ventana de prueba', 'scheduled_pickup', '{0,1,2,3,4,5,6}', '23:59', ${weekdayOf(date)}, '10:00', '18:00', 1) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into pickup_points(name, address, is_default) values ('Mostrador', 'Calle 1', true)`.execute(
    db,
  );
  concha = await product("Concha", 2500);
  croissant = await product("Croissant", 4500, { channel: "web" });
  soloPos = await product("Solo POS", 3000, { showOnWeb: false });
  inactivo = await product("Inactivo", 3000, { active: false });
  agotado = await product("Agotado", 3000, { allowPreorder: false });
  sinPrecioWeb = await product("Sin precio web", 3000, { channel: "pos" });
  ana = (
    await sql<{
      r: typeof ana;
    }>`select register_customer('{"full_name":"Ana López Ruiz","phone":"6641234567","email":"ana@example.com"}'::jsonb) as r`.execute(
      db,
    )
  ).rows[0]!.r;
});

describe("checkout web · validaciones del servidor", () => {
  it("flag web_checkout apagado → mensaje claro y cero pedidos", async () => {
    await sql`update feature_flags set enabled = false where key = 'web_checkout'`.execute(db);
    const r = await placeOrderAction(base());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/pausados/i) });
    expect(await orderCount()).toBe(0);
  });

  it("fecha vencida o ventana desconocida → error en el campo fecha, sin pedido", async () => {
    const r1 = await placeOrderAction(base({ date: addDays(date, -2) }));
    expect(r1).toMatchObject({ ok: false, field: "date" });
    const r2 = await placeOrderAction(base({ window_id: crypto.randomUUID() }));
    expect(r2).toMatchObject({ ok: false, field: "date" });
    await sql`update ordering_windows set is_active = false`.execute(db);
    const r3 = await placeOrderAction(base());
    expect(r3).toMatchObject({ ok: false, field: "date" });
    expect(await orderCount()).toBe(0);
  });

  it("feriado en la fecha de entrega → la fecha deja de ser válida", async () => {
    await sql`insert into calendar_exceptions(date, is_closed, no_orders, note) values (${date}, true, true, 'Feriado')`.execute(
      db,
    );
    expect(await placeOrderAction(base())).toMatchObject({ ok: false, field: "date" });
    expect(await orderCount()).toBe(0);
  });

  it("teléfono: 9 dígitos falla; 10, 11 y +52 se aceptan y +52 se guarda como 10 dígitos", async () => {
    expect(await placeOrderAction(base({ customer_phone: "664987654" }))).toMatchObject({
      ok: false,
      field: "customer_phone",
    });
    const r10 = await placeOrderAction(base({ customer_phone: "(664) 987-6543" }));
    expect(r10.ok).toBe(true);
    if (r10.ok) expect((await orderFromRedirect(r10.redirect)).customer_phone).toBe("6649876543");
    const r52 = await placeOrderAction(base({ customer_phone: "+52 664 111 2233" }));
    expect(r52.ok).toBe(true);
    if (r52.ok) expect((await orderFromRedirect(r52.redirect)).customer_phone).toBe("6641112233");
    const r11 = await placeOrderAction(base({ customer_phone: "16649876543" }));
    expect(r11.ok).toBe(true);
    expect(await orderCount()).toBe(3);
  });

  it("correo inválido falla; correo en mayúsculas se guarda en minúsculas; nombre Unicode se acepta", async () => {
    expect(await placeOrderAction(base({ customer_email: "correo@" }))).toMatchObject({
      ok: false,
      field: "customer_email",
    });
    const r = await placeOrderAction(
      base({ customer_name: "Zoë Ñandú 李小龙", customer_email: "Cliente@Example.COM" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    expect(o.customer_email).toBe("cliente@example.com");
    const name = await sql<{
      customer_name: string;
    }>`select customer_name from orders where id = ${o.id}`.execute(db);
    expect(name.rows[0]!.customer_name).toBe("Zoë Ñandú 李小龙");
  });

  it("productos no vendibles en web (no existe, solo POS, inactivo, agotado sin preventa, sin precio web) → error items", async () => {
    for (const pid of [crypto.randomUUID(), soloPos, inactivo, sinPrecioWeb]) {
      const r = await placeOrderAction(base({ items: [{ product_id: pid, qty: 1 }] }));
      expect(r).toMatchObject({ ok: false, field: "items" });
    }
    const r = await placeOrderAction(base({ items: [{ product_id: agotado, qty: 1 }] }));
    expect(r).toMatchObject({ ok: false, field: "items", error: expect.stringMatching(/Agotado/) });
    // Cantidades imposibles nunca llegan a la base
    expect(await placeOrderAction(base({ items: [{ product_id: concha, qty: 0 }] }))).toMatchObject(
      {
        ok: false,
      },
    );
    expect(
      await placeOrderAction(base({ items: [{ product_id: concha, qty: 1.5 }] })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await placeOrderAction(base({ items: [{ product_id: concha, qty: 999 }] })),
    ).toMatchObject({
      ok: false,
    });
    expect(await placeOrderAction(base({ items: [] }))).toMatchObject({
      ok: false,
      field: "items",
    });
    expect(await orderCount()).toBe(0);
  });
});

describe("checkout web · modalidades", () => {
  it("retiro: respeta el punto elegido; uno inexistente o inactivo cae al punto por defecto", async () => {
    const def = (
      await sql<{ id: string }>`select id from pickup_points where is_default`.execute(db)
    ).rows[0]!.id;
    const second = (
      await sql<{
        id: string;
      }>`insert into pickup_points(name, address, is_default) values ('Sucursal Norte', 'Av. 2', false) returning id`.execute(
        db,
      )
    ).rows[0]!.id;
    const inactive = (
      await sql<{
        id: string;
      }>`insert into pickup_points(name, is_default, is_active) values ('Cerrada', false, false) returning id`.execute(
        db,
      )
    ).rows[0]!.id;
    const pointOf = async (redirect: string) => {
      const o = await orderFromRedirect(redirect);
      const r = await sql<{
        pickup_point_id: string | null;
        fulfillment_type: string;
      }>`select pickup_point_id, fulfillment_type from orders where id = ${o.id}`.execute(db);
      return r.rows[0]!;
    };
    const a = await placeOrderAction(base({ pickup_point_id: second }));
    expect(a.ok).toBe(true);
    if (a.ok)
      expect(await pointOf(a.redirect)).toEqual({
        pickup_point_id: second,
        fulfillment_type: "scheduled_pickup",
      });
    for (const pid of [inactive, crypto.randomUUID(), undefined]) {
      const r = await placeOrderAction(base({ pickup_point_id: pid }));
      expect(r.ok).toBe(true);
      if (r.ok) expect((await pointOf(r.redirect)).pickup_point_id).toBe(def);
    }
  });

  it("entrega a domicilio: exige dirección, cobra el envío de las políticas y no asigna punto de retiro", async () => {
    await sql`update business_settings set policies = '{"delivery_fee_cents": 3500, "delivery_zone": "Centro"}'::jsonb where id = 1`.execute(
      db,
    );
    const deliveryWindow = (
      await sql<{
        id: string;
      }>`insert into ordering_windows(name, fulfillment_type, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, lead_days_min, sort_order)
        values ('Entrega', 'delivery', '{0,1,2,3,4,5,6}', '23:59', ${weekdayOf(date)}, '12:00', '15:00', 1, 1) returning id`.execute(
        db,
      )
    ).rows[0]!.id;
    const d = (over: Partial<Parameters<Actions["placeOrderAction"]>[0]> = {}) =>
      base({ window_id: deliveryWindow, ...over });
    expect(await placeOrderAction(d())).toMatchObject({ ok: false, field: "delivery_address" });
    expect(await placeOrderAction(d({ delivery_address: { street: "ab" } }))).toMatchObject({
      ok: false,
      field: "delivery_address",
    });
    expect(await orderCount()).toBe(0);
    const r = await placeOrderAction(
      d({
        // un punto de retiro enviado por el cliente se ignora en entregas
        pickup_point_id: (
          await sql<{ id: string }>`select id from pickup_points limit 1`.execute(db)
        ).rows[0]!.id,
        delivery_address: {
          street: "Calle Olivo 123",
          neighborhood: "Centro",
          references_note: "Portón verde",
        },
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    const row = await sql<{
      fulfillment_type: string;
      pickup_point_id: string | null;
      delivery_address: Record<string, string>;
      delivery_fee_cents: number;
    }>`select fulfillment_type, pickup_point_id, delivery_address, delivery_fee_cents from orders where id = ${o.id}`.execute(
      db,
    );
    expect(row.rows[0]).toEqual({
      fulfillment_type: "delivery",
      pickup_point_id: null,
      delivery_address: {
        street: "Calle Olivo 123",
        neighborhood: "Centro",
        references_note: "Portón verde",
      },
      delivery_fee_cents: 3500,
    });
    expect(o.subtotal_cents).toBe(5000);
    expect(o.total_cents).toBe(8500);
    expect(o.scheduled_for.toISOString()).toBe(zonedToUtc(date, "12:00", TZ).toISOString());
  });
});

describe("checkout web · métodos de pago", () => {
  it("efectivo: pedido confirmado con precios del servidor (ignora lo que diga el cliente)", async () => {
    // El cliente "cree" pagar otra cosa: el servidor recalcula con current_price_cents(web).
    const r = await placeOrderAction(
      base({
        items: [
          { product_id: concha, qty: 2 },
          { product_id: croissant, qty: 1 },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    expect(o.status).toBe("confirmed");
    expect(o.payment_status).toBe("pending");
    expect(o.subtotal_cents).toBe(2 * 2500 + 4500);
    expect(o.total_cents).toBe(9500);
    expect(o.internal_notes).toMatch(/efectivo/);
    expect(o.u.searchParams.get("nuevo")).toBe("1");
    expect(o.scheduled_for.toISOString()).toBe(zonedToUtc(date, "10:00", TZ).toISOString());
    const items = await sql<{
      unit_price_cents: number;
      qty: string;
    }>`select unit_price_cents, qty from order_items where order_id = ${o.id} order by sort_order`.execute(
      db,
    );
    expect(items.rows.map((i) => [i.unit_price_cents, Number(i.qty)])).toEqual([
      [2500, 2],
      [4500, 1],
    ]);
    const hist = await sql<{
      to_status: string;
    }>`select to_status from order_status_history where order_id = ${o.id} order by id`.execute(db);
    expect(hist.rows.map((h) => h.to_status)).toEqual(["new", "confirmed"]);
    // Sin correo del cliente no hay comprobante que registrar
    expect((await sql`select 1 from receipts`.execute(db)).rows).toHaveLength(0);
  });

  it("transferencia solo con instrucciones configuradas; con ellas queda pago pendiente registrado", async () => {
    expect(await placeOrderAction(base({ payment_method: "transfer" }))).toMatchObject({
      ok: false,
      field: "payment_method",
    });
    expect(await orderCount()).toBe(0);
    await sql`update business_settings set policies = '{"transfer_instructions":"CLABE 012 345"}'::jsonb where id = 1`.execute(
      db,
    );
    const r = await placeOrderAction(base({ payment_method: "transfer" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    expect(o.status).toBe("confirmed");
    const pay = await sql<{
      method: string;
      status: string;
      amount_cents: number;
    }>`select method, status, amount_cents from payments where order_id = ${o.id}`.execute(db);
    expect(pay.rows).toEqual([{ method: "transfer", status: "pending", amount_cents: 5000 }]);
  });

  it("Mercado Pago con flag apagado, o encendido sin token → mensaje claro y cero pedidos huérfanos", async () => {
    const off = await placeOrderAction(base({ payment_method: "mercadopago" }));
    expect(off).toMatchObject({
      ok: false,
      field: "payment_method",
      error: expect.stringMatching(/no está disponible/),
    });
    await sql`update feature_flags set enabled = true where key = 'mercadopago_online'`.execute(db);
    const on = await placeOrderAction(base({ payment_method: "mercadopago" }));
    expect(on).toMatchObject({ ok: false, field: "payment_method" });
    expect(await orderCount()).toBe(0);
  });
});

describe("checkout web · cupones", () => {
  beforeEach(async () => {
    await sql`insert into coupons(code, kind, value_bps, channels) values ('DIEZ', 'pct', 1000, '{all}')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, channels) values ('SOLOPOS', 'pct', 1000, '{pos}')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, ends_at) values ('VENCIDO', 'amount', 1000, now() - interval '1 day')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, min_subtotal_cents) values ('MINIMO', 'amount', 1000, 100000)`.execute(
      db,
    );
  });

  it("previsualización: cada rechazo tiene un motivo legible", async () => {
    const items = [{ productId: concha, qty: 2 }];
    expect(await validateCouponAction({ code: "NOEXISTE", items })).toMatchObject({
      ok: false,
      error: /no existe/,
    });
    expect(await validateCouponAction({ code: "SOLOPOS", items })).toMatchObject({
      ok: false,
      error: /en línea/,
    });
    expect(await validateCouponAction({ code: "VENCIDO", items })).toMatchObject({
      ok: false,
      error: /venció/,
    });
    expect(await validateCouponAction({ code: "MINIMO", items })).toMatchObject({
      ok: false,
      error: /mínimo/,
    });
    expect(await validateCouponAction({ code: "diez", items })).toMatchObject({
      ok: true,
      code: "DIEZ",
      discountCents: 500,
    });
    expect(await validateCouponAction({ code: "DIEZ", items: [] })).toMatchObject({ ok: false });
  });

  it("al confirmar, el cupón se vuelve a validar en el servidor: inválido → error sin pedido; válido → descuento aplicado", async () => {
    for (const code of ["NOEXISTE", "SOLOPOS", "VENCIDO", "MINIMO"]) {
      const r = await placeOrderAction(base({ coupon_code: code }));
      expect(r, code).toMatchObject({ ok: false, field: "coupon_code" });
    }
    expect(await orderCount()).toBe(0);
    const r = await placeOrderAction(base({ coupon_code: "DIEZ" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    expect(o.coupon_code).toBe("DIEZ");
    expect(o.discount_cents).toBe(500);
    expect(o.total_cents).toBe(4500);
  });
});

describe("checkout web · idempotencia y concurrencia", () => {
  it("el mismo envío repetido (refresh / atrás) devuelve el mismo pedido", async () => {
    const payload = base();
    const a = await placeOrderAction(payload);
    const b = await placeOrderAction(payload);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(new URL(b.redirect).pathname).toBe(new URL(a.redirect).pathname);
    expect(await orderCount()).toBe(1);
  });

  it("dos envíos simultáneos con la misma clave crean un solo pedido y ambos terminan bien", async () => {
    const payload = base();
    const [a, b] = await Promise.all([placeOrderAction(payload), placeOrderAction(payload)]);
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(b.ok, JSON.stringify(b)).toBe(true);
    if (a.ok && b.ok) expect(new URL(b.redirect).pathname).toBe(new URL(a.redirect).pathname);
    expect(await orderCount()).toBe(1);
  });

  it("claves distintas (dos pestañas con el mismo carrito) crean dos pedidos: es el comportamiento esperado", async () => {
    await placeOrderAction(base());
    await placeOrderAction(base());
    expect(await orderCount()).toBe(2);
  });

  it("rate limit: 20 intentos por IP en 10 min; el 21.º se rechaza con mensaje", async () => {
    ip = "198.51.100.7";
    for (let i = 0; i < 20; i++) {
      const r = await placeOrderAction(base({ items: [] }));
      expect(r).toMatchObject({ ok: false, field: "items" });
    }
    const blocked = await placeOrderAction(base());
    expect(blocked).toMatchObject({
      ok: false,
      error: expect.stringMatching(/demasiados intentos/i),
    });
    expect(await orderCount()).toBe(0);
  });
});

describe("checkout web · cliente y comprobantes", () => {
  it("'ya soy cliente' vincula por teléfono/código sin revelar datos; el teléfono con +52 también encuentra", async () => {
    expect(await lookupCustomerAction("6641234567")).toEqual({ found: true, hint: "Ana L." });
    expect(await lookupCustomerAction("+52 664 123 4567")).toEqual({ found: true, hint: "Ana L." });
    expect(await lookupCustomerAction(ana.public_code.toLowerCase())).toEqual({
      found: true,
      hint: "Ana L.",
    });
    expect(await lookupCustomerAction("0000000000")).toMatchObject({ found: false });
    expect(await lookupCustomerAction("123")).toMatchObject({ found: false });
    const r = await placeOrderAction(base({ customer_lookup: "+52 664 123 4567" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((await orderFromRedirect(r.redirect)).customer_id).toBe(ana.customer_id);
  });

  it("sin vínculo explícito, el teléfono del pedido enlaza al cliente existente; con consentimiento se da de alta uno nuevo", async () => {
    const r1 = await placeOrderAction(base({ customer_phone: "664 123 4567" }));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect((await orderFromRedirect(r1.redirect)).customer_id).toBe(ana.customer_id);
    const r2 = await placeOrderAction(
      base({ customer_phone: "6647778899", marketing_consent: true }),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const o = await orderFromRedirect(r2.redirect);
    const c = await sql<{
      phone: string;
      source: string;
      marketing_consent: boolean;
    }>`select phone, source, marketing_consent from customers where id = ${o.customer_id}`.execute(
      db,
    );
    expect(c.rows[0]).toEqual({ phone: "6647778899", source: "web", marketing_consent: true });
    const r3 = await placeOrderAction(
      base({ customer_phone: "6640001111", marketing_consent: false }),
    );
    expect(r3.ok).toBe(true);
    if (r3.ok) expect((await orderFromRedirect(r3.redirect)).customer_id).toBeNull();
  });

  it("sin Resend configurado el pedido se crea igual y queda constancia del correo omitido en receipts", async () => {
    const r = await placeOrderAction(base({ customer_email: "cliente@example.com" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = await orderFromRedirect(r.redirect);
    const rec = await sql<{
      channel: string;
      destination: string;
      status: string;
      error: string | null;
    }>`select channel, destination, status, error from receipts where order_id = ${o.id}`.execute(
      db,
    );
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]).toMatchObject({
      channel: "email",
      destination: "cliente@example.com",
      status: "failed",
    });
    expect(rec.rows[0]!.error).toMatch(/RESEND_API_KEY/);
  });
});
