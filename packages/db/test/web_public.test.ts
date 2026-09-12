import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testDb, truncateAll, createProduct, sql, callFn } from "./helpers.ts";

const { db, pool } = testDb();
let product: string;

beforeEach(async () => {
  await truncateAll(db);
  product = await createProduct(db, "Concha", 2500);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("sitio público: public_token de pedidos", () => {
  it("cada pedido nace con un token opaco, único y de 32 hex", async () => {
    const a = await callFn<string>(db, "create_order", [
      JSON.stringify({
        channel: "web",
        customer_name: "Ana",
        customer_phone: "6641112222",
        items: [{ product_id: product, qty: 1 }],
      }),
    ]);
    const b = await callFn<string>(db, "create_order", [
      JSON.stringify({
        channel: "web",
        customer_name: "Luis",
        customer_phone: "6643334444",
        items: [{ product_id: product, qty: 2 }],
      }),
    ]);
    const r = await sql<{
      id: string;
      public_token: string;
    }>`select id, public_token from orders order by placed_at`.execute(db);
    expect(r.rows.map((x) => x.id)).toEqual([a, b]);
    for (const row of r.rows) expect(row.public_token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.rows[0]!.public_token).not.toBe(r.rows[1]!.public_token);
  });

  it("folio + token correcto resuelve el pedido; token ajeno no", async () => {
    const id = await callFn<string>(db, "create_order", [
      JSON.stringify({
        channel: "web",
        customer_name: "Ana",
        customer_phone: "6641112222",
        items: [{ product_id: product, qty: 1 }],
      }),
    ]);
    const o = await sql<{
      folio: string;
      public_token: string;
    }>`select folio, public_token from orders where id = ${id}`.execute(db);
    const { folio, public_token } = o.rows[0]!;
    const ok = await sql<{
      id: string;
    }>`select id from orders where folio = ${folio} and public_token = ${public_token}`.execute(db);
    expect(ok.rows[0]!.id).toBe(id);
    const bad = await sql<{
      id: string;
    }>`select id from orders where folio = ${folio} and public_token = ${"0".repeat(32)}`.execute(
      db,
    );
    expect(bad.rows).toHaveLength(0);
    const idx = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where tablename = 'orders' and indexname = 'orders_public_token_idx'`.execute(
      db,
    );
    expect(idx.rows[0]!.indexdef).toMatch(/UNIQUE/);
  });
});

describe("sitio público: rate_limits", () => {
  it("permite hasta el máximo por ventana y bloquea después", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await callFn<{ allowed: boolean; hits: number; limit: number }>(
        db,
        "rate_limit_hit",
        ["1.2.3.4", "checkout", 600, 3],
      );
      results.push(r.allowed);
      expect(r.hits).toBe(i + 1);
      expect(r.limit).toBe(3);
    }
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("separa contadores por clave y por ruta", async () => {
    for (let i = 0; i < 3; i++) await callFn(db, "rate_limit_hit", ["10.0.0.1", "checkout", 600, 3]);
    const blocked = await callFn<{ allowed: boolean }>(db, "rate_limit_hit", [
      "10.0.0.1",
      "checkout",
      600,
      3,
    ]);
    expect(blocked.allowed).toBe(false);
    const otherRoute = await callFn<{ allowed: boolean; hits: number }>(db, "rate_limit_hit", [
      "10.0.0.1",
      "register",
      600,
      3,
    ]);
    expect(otherRoute).toMatchObject({ allowed: true, hits: 1 });
    const otherIp = await callFn<{ allowed: boolean; hits: number }>(db, "rate_limit_hit", [
      "10.0.0.2",
      "checkout",
      600,
      3,
    ]);
    expect(otherIp).toMatchObject({ allowed: true, hits: 1 });
  });

  it("rechaza clave vacía y devuelve fin de ventana futuro", async () => {
    await expect(callFn(db, "rate_limit_hit", ["", "checkout", 600, 3])).rejects.toThrow(
      /clave vacía/,
    );
    const r = await callFn<{ resets_at: string }>(db, "rate_limit_hit", [
      "9.9.9.9",
      "checkout",
      600,
      20,
    ]);
    expect(new Date(r.resets_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("la tabla tiene RLS y pdp_app puede usarla; anon no", async () => {
    const r = await sql<{
      rls: boolean;
      app: boolean;
      anon: boolean;
    }>`select c.relrowsecurity as rls,
              has_table_privilege('pdp_app', 'rate_limits', 'insert') as app,
              has_table_privilege('anon', 'rate_limits', 'select') as anon
         from pg_class c where c.relname = 'rate_limits'`.execute(db);
    expect(r.rows[0]).toEqual({ rls: true, app: true, anon: false });
    const f = await sql<{
      anon: boolean;
      app: boolean;
    }>`select has_function_privilege('anon', 'rate_limit_hit(text,text,integer,integer)', 'execute') as anon,
              has_function_privilege('pdp_app', 'rate_limit_hit(text,text,integer,integer)', 'execute') as app`.execute(
      db,
    );
    expect(f.rows[0]).toEqual({ anon: false, app: true });
  });
});
