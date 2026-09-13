/**
 * Auditoría del sitio público a nivel SQL: precios siempre del servidor, idempotencia bajo concurrencia,
 * motivos de cupón por canal/vigencia/mínimo, normalización en register_customer, alcance de find_customer
 * (por eso la tarjeta pública NO debe usarlo) y rate limit con los valores por defecto (20 / 10 min).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll, createProduct, createCustomer, sql, callFn } from "./helpers.ts";

const { db, pool } = testDb();
let concha: string;

beforeEach(async () => {
  await truncateAll(db);
  concha = await createProduct(db, "Concha", 2500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

const webOrder = (over: Record<string, unknown> = {}) => ({
  channel: "web",
  price_channel: "web",
  customer_name: "Ana",
  customer_phone: "6641112222",
  items: [{ product_id: concha, qty: 2 }],
  ...over,
});

describe("create_order desde web", () => {
  it("ignora el precio que manda el cliente: el total sale de current_price_cents(web)", async () => {
    const id = await callFn<string>(db, "create_order", [
      JSON.stringify(webOrder({ items: [{ product_id: concha, qty: 2, unit_price_cents: 1 }] })),
    ]);
    const o = await sql<{
      subtotal_cents: number;
      total_cents: number;
    }>`select subtotal_cents, total_cents from orders where id = ${id}`.execute(db);
    expect(o.rows[0]).toEqual({ subtotal_cents: 5000, total_cents: 5000 });
  });

  it("dos llamadas simultáneas con la misma idempotency_key producen un solo pedido", async () => {
    const payload = JSON.stringify(webOrder({ idempotency_key: "web-audit-race-0001" }));
    const results = await Promise.allSettled([
      callFn<string>(db, "create_order", [payload]),
      callFn<string>(db, "create_order", [payload]),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const f of failed) expect((f.reason as { code?: string }).code).toBe("23505"); // índice único
    const n = await sql<{ n: string }>`select count(*) as n from orders`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(1);
    if (ok.length === 2) expect(ok[0]!.value).toBe(ok[1]!.value);
  });

  it("producto inactivo, no web o sin precio web se rechaza con mensaje", async () => {
    const soloPos = await createProduct(db, "Solo POS", 3000);
    await sql`update products set show_on_web = false where id = ${soloPos}`.execute(db);
    await expect(
      callFn(db, "create_order", [
        JSON.stringify(webOrder({ items: [{ product_id: soloPos, qty: 1 }] })),
      ]),
    ).rejects.toThrow(/no se vende en línea/);
    const inactivo = await createProduct(db, "Inactivo", 3000);
    await sql`update products set is_active = false where id = ${inactivo}`.execute(db);
    await expect(
      callFn(db, "create_order", [
        JSON.stringify(webOrder({ items: [{ product_id: inactivo, qty: 1 }] })),
      ]),
    ).rejects.toThrow(/no está disponible/);
    const sinPrecio = await createProduct(db, "Sin precio", 3000);
    await sql`update product_prices set channel = 'pos' where product_id = ${sinPrecio}`.execute(
      db,
    );
    await expect(
      callFn(db, "create_order", [
        JSON.stringify(webOrder({ items: [{ product_id: sinPrecio, qty: 1 }] })),
      ]),
    ).rejects.toThrow(/no tiene precio/);
    const n = await sql<{ n: string }>`select count(*) as n from orders`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it("cupón inválido aborta la creación (no queda pedido a medias)", async () => {
    await expect(
      callFn(db, "create_order", [JSON.stringify(webOrder({ coupon_code: "NOEXISTE" }))]),
    ).rejects.toThrow(/Cupón inválido: not_found/);
    const n = await sql<{ n: string }>`select count(*) as n from orders`.execute(db);
    expect(Number(n.rows[0]!.n)).toBe(0);
  });
});

describe("validate_coupon · motivos que ve el sitio", () => {
  it("canal pos vs web, vencido, aún no empieza, mínimo, agotado y segmentado", async () => {
    await sql`insert into coupons(code, kind, value_bps, channels) values ('SOLOPOS','pct',1000,'{pos}')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, ends_at) values ('VENCIDO','amount',1000, now() - interval '1 minute')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, starts_at) values ('FUTURO','amount',1000, now() + interval '1 day')`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, min_subtotal_cents) values ('MINIMO','amount',1000, 100000)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_cents, max_uses, uses_count) values ('AGOTADO','amount',1000, 1, 1)`.execute(
      db,
    );
    await sql`insert into coupons(code, kind, value_bps, segment) values ('NUEVOS','pct',1000,'{"new_customers_only":true}')`.execute(
      db,
    );
    const reason = async (code: string, customer: string | null = null) =>
      (
        await callFn<{ valid: boolean; reason?: string }>(db, "validate_coupon", [
          code,
          customer,
          5000,
          "web",
          "[]",
        ])
      ).reason;
    expect(await reason("SOLOPOS")).toBe("channel");
    expect(await reason("VENCIDO")).toBe("expired");
    expect(await reason("FUTURO")).toBe("not_started");
    expect(await reason("MINIMO")).toBe("min_subtotal");
    expect(await reason("AGOTADO")).toBe("exhausted");
    expect(await reason("NUEVOS")).toBe("requires_customer");
    const c = await createCustomer(db, "Ana", "6641234567");
    const ok = await callFn<{ valid: boolean; discount_cents: number }>(db, "validate_coupon", [
      "NUEVOS",
      c.customer_id,
      5000,
      "web",
      "[]",
    ]);
    expect(ok).toMatchObject({ valid: true, discount_cents: 500 });
    // El mismo cupón en POS sigue rechazando por canal
    expect(
      (
        await callFn<{ reason?: string }>(db, "validate_coupon", [
          "SOLOPOS",
          null,
          5000,
          "pos",
          "[]",
        ])
      ).reason,
    ).toBeUndefined();
  });
});

describe("register_customer y find_customer", () => {
  it("normaliza el correo a minúsculas y el teléfono a dígitos; el repetido devuelve created=false", async () => {
    const a = await callFn<{ customer_id: string; created: boolean }>(db, "register_customer", [
      JSON.stringify({ full_name: "Ana", phone: "(664) 123-4567", email: "ANA@Example.com" }),
    ]);
    const row = await sql<{
      phone: string;
      email: string;
    }>`select phone, email from customers where id = ${a.customer_id}`.execute(db);
    expect(row.rows[0]).toEqual({ phone: "6641234567", email: "ana@example.com" });
    const b = await callFn<{ customer_id: string; created: boolean }>(db, "register_customer", [
      JSON.stringify({ full_name: "Otra", phone: "6641234567" }),
    ]);
    expect(b).toMatchObject({ customer_id: a.customer_id, created: false });
    const c = await callFn<{ customer_id: string; created: boolean }>(db, "register_customer", [
      JSON.stringify({ full_name: "Otra", email: "ana@EXAMPLE.com" }),
    ]);
    expect(c).toMatchObject({ customer_id: a.customer_id, created: false });
  });

  it("find_customer resuelve por qr_token, código (cualquier mayúscula), teléfono y correo: por eso la tarjeta pública no debe usarlo", async () => {
    const c = await createCustomer(db, "Ana López", "6641234567");
    await sql`update customers set email = 'ana@example.com' where id = ${c.customer_id}`.execute(
      db,
    );
    for (const q of [
      c.qr_token,
      c.public_code,
      c.public_code.toLowerCase(),
      "6641234567",
      "ana@example.com",
    ]) {
      const r = await sql<{ id: string }>`select id from find_customer(${q})`.execute(db);
      expect(r.rows[0]?.id, q).toBe(c.customer_id);
    }
    const strict = await sql<{
      id: string;
    }>`select id from customers where qr_token = ${"6641234567"}`.execute(db);
    expect(strict.rows).toHaveLength(0);
  });
});

describe("rate_limit_hit · valores por defecto del sitio", () => {
  it("20 peticiones pasan y la 21.ª se bloquea en la misma ventana de 10 minutos", async () => {
    let last: { allowed: boolean; hits: number; limit: number } | null = null;
    for (let i = 0; i < 21; i++) {
      last = await callFn(db, "rate_limit_hit", ["203.0.113.9", "checkout", 600, 20]);
      if (i < 20) expect(last!.allowed).toBe(true);
    }
    expect(last).toMatchObject({ allowed: false, hits: 21, limit: 20 });
  });
});
