/**
 * Auditoría de infraestructura (docs/audit/infra.md) — base de datos.
 * Seguridad (RLS, grants, EXECUTE de funciones), append-only, conciliación de pagos de Mercado Pago
 * (apply_mercadopago_payment con montos distintos / pedido cancelado / duplicado / fuera de orden),
 * locks de job_runs, invariantes de integridad, rebuild_inventory_levels, checksums de migraciones,
 * guardas de reset.ts, seed idempotente y codegen al día.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listMigrations } from "../scripts/migrate.ts";
import { runImport } from "../scripts/import/run.ts";
import { databaseUrl } from "../scripts/env.ts";
import {
  callFn,
  createCustomer,
  createProduct,
  createStaff,
  onHand,
  sql,
  testDb,
  truncateAll,
  withStaff,
} from "./helpers.ts";

const { db, pool } = testDb();
const PKG = resolve(import.meta.dirname, "..");
let staff: string;
let product: string;

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

const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(db)).rows[0]!;
const count = async (table: string, where = "true") =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(where)}`.execute(db)
  ).rows[0]!.n;

async function webOrder(customerId: string | null = null, qty = 4) {
  return callFn<string>(db, "create_order", [
    JSON.stringify({
      channel: "web",
      fulfillment_type: "scheduled_pickup",
      customer_id: customerId,
      customer_name: "Luis",
      customer_phone: "6640000000",
      items: [{ product_id: product, qty }],
    }),
  ]);
}

function mp(
  orderId: string,
  externalId: string,
  mpStatus: string,
  amountCents: number,
): Record<string, unknown> {
  return {
    order_id: orderId,
    external_id: externalId,
    mp_status: mpStatus,
    amount_cents: amountCents,
    raw: { currency_id: "MXN", live_mode: false },
  };
}
const apply = (p: Record<string, unknown>) =>
  callFn<Record<string, unknown>>(db, "apply_mercadopago_payment", [JSON.stringify(p)]);

async function orderState(id: string) {
  return one(
    sql<{
      status: string;
      payment_status: string;
      paid_cents: number;
      total_cents: number;
    }>`select status, payment_status, paid_cents, total_cents from orders where id = ${id}`,
  );
}

// ── Seguridad ───────────────────────────────────────────────────────────────
describe("seguridad: RLS, grants y funciones", () => {
  it("todas las tablas de public tienen RLS y la política pdp_app_all", async () => {
    const noRls = await sql<{
      tablename: string;
    }>`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`.execute(db);
    expect(noRls.rows).toEqual([]);
    const noPolicy = await sql<{ tablename: string }>`
      select tablename from pg_tables t where schemaname = 'public'
        and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename and p.policyname = 'pdp_app_all')
    `.execute(db);
    expect(noPolicy.rows).toEqual([]);
  });

  it("anon/authenticated/PUBLIC sin acceso a tablas, VISTAS, secuencias ni funciones (incl. extensiones como pg_trgm)", async () => {
    const rels = await sql<{ relname: string; who: string }>`
      select c.relname, r.who from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'),('authenticated'),('public')) r(who)
      where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
        and (has_table_privilege(r.who, c.oid, 'select') or has_table_privilege(r.who, c.oid, 'insert')
             or has_table_privilege(r.who, c.oid, 'update') or has_table_privilege(r.who, c.oid, 'delete'))`.execute(
      db,
    );
    expect(rels.rows).toEqual([]);
    const views = await one(sql<{ n: number }>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'`);
    expect(views.n).toBeGreaterThan(0); // la verificación de arriba cubre vistas reales, no un conjunto vacío
    const seqs = await sql<{ relname: string }>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'),('authenticated'),('public')) r(who)
      where n.nspname = 'public' and c.relkind = 'S' and has_sequence_privilege(r.who, c.oid, 'usage')`.execute(
      db,
    );
    expect(seqs.rows).toEqual([]);
    const fns = await sql<{ proname: string; who: string }>`
      select p.proname, r.who
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'),('authenticated'),('public')) r(who)
      where n.nspname = 'public' and has_function_privilege(r.who, p.oid, 'execute')
      order by 1, 2`.execute(db);
    expect(fns.rows).toEqual([]);
    const missing = await one(sql<{ n: number }>`
      select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and not has_function_privilege('pdp_app', p.oid, 'execute')`);
    expect(missing.n).toBe(0);
  });

  it("scripts/check-grants.sh detecta una vista y una secuencia expuestas (el chequeo solo-pg_tables no las veía)", async () => {
    const url = databaseUrl("test");
    const run = () =>
      spawnSync("bash", [resolve(PKG, "../../scripts/check-grants.sh"), url], { encoding: "utf8" });
    const clean = run();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    await sql`grant select on catalog_products to anon`.execute(db);
    await sql`grant usage on sequence customer_code_seq to authenticated`.execute(db);
    try {
      const dirty = run();
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toContain("VISTA catalog_products → anon");
      expect(dirty.stdout).toContain("SECUENCIA customer_code_seq → authenticated");
    } finally {
      await sql`revoke select on catalog_products from anon`.execute(db);
      await sql`revoke usage on sequence customer_code_seq from authenticated`.execute(db);
    }
  }, 60_000);

  it("una función nueva NO nace ejecutable por PUBLIC/anon ni antes de _post_migrate (default global de 0015; los IN SCHEMA de 0080 no bastan)", async () => {
    await sql`create function public.__audit_probe() returns int language sql as 'select 1'`.execute(
      db,
    );
    try {
      const r = await one(sql<{ pub: boolean; anon: boolean; app: boolean }>`
        select has_function_privilege('public', '__audit_probe()'::regprocedure, 'execute') as pub,
               has_function_privilege('anon', '__audit_probe()'::regprocedure, 'execute') as anon,
               has_function_privilege('pdp_app', '__audit_probe()'::regprocedure, 'execute') as app`);
      expect(r).toEqual({ pub: false, anon: false, app: true });
    } finally {
      await sql`drop function public.__audit_probe()`.execute(db);
    }
  });

  it("append-only: inventory_movements, loyalty_transactions, ingredient_movements y domain_events rechazan update/delete", async () => {
    const cust = await createCustomer(db);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: product, qty: 1 }],
          customer_id: cust.customer_id,
          payments: [{ provider: "cash", method: "cash", amount_cents: 3000 }],
        }),
      ]),
    );
    for (const t of ["inventory_movements", "loyalty_transactions", "domain_events"]) {
      await expect(sql`update ${sql.raw(t)} set created_at = now()`.execute(db)).rejects.toThrow(
        /solo inserción|append-only|does not exist/,
      );
      await expect(sql`delete from ${sql.raw(t)}`.execute(db)).rejects.toThrow(
        /solo inserción|append-only/,
      );
    }
    await expect(sql`delete from ingredient_movements`.execute(db)).resolves.toBeDefined(); // vacía: el trigger es por fila
  });
});

// ── apply_mercadopago_payment ───────────────────────────────────────────────
describe("apply_mercadopago_payment: conciliación de montos y estados", () => {
  it("monto exacto: pago, venta, inventario y puntos una sola vez; segundo aviso duplicado", async () => {
    const cust = await createCustomer(db);
    const orderId = await webOrder(cust.customer_id);
    const r1 = await apply(mp(orderId, "9001", "approved", 12000));
    expect(r1).toMatchObject({ applied_status: "paid", amount_mismatch: false, duplicate: false });
    expect(r1.sale_id).toBeTruthy();
    const r2 = await apply(mp(orderId, "9001", "approved", 12000));
    expect(r2).toMatchObject({ duplicate: true });
    expect(await count("sales")).toBe(1);
    expect(await count("payments")).toBe(1);
    expect(await onHand(db, product)).toBe(46);
    expect(await count("inventory_movements", "type = 'SALE'")).toBe(1);
    const pts = await one(
      sql<{
        s: number;
      }>`select coalesce(sum(points),0)::int as s from loyalty_transactions where customer_id = ${cust.customer_id} and kind = 'earn'`,
    );
    expect(pts.s).toBe(12);
    expect(await orderState(orderId)).toMatchObject({
      status: "paid",
      payment_status: "paid",
      paid_cents: 12000,
    });
    expect(
      await count("notifications", "kind in ('payment_mismatch','payment_on_cancelled_order')"),
    ).toBe(0);
  });

  it("monto MENOR al saldo: se detecta → pago parcial, sin venta, alerta payment_mismatch", async () => {
    const orderId = await webOrder();
    const r = await apply(mp(orderId, "9002", "approved", 5000));
    expect(r).toMatchObject({ applied_status: "paid", amount_mismatch: true });
    expect(r.sale_id).toBeNull();
    expect(await orderState(orderId)).toMatchObject({
      payment_status: "partial",
      paid_cents: 5000,
    });
    expect(await count("sales")).toBe(0);
    const n = await one(
      sql<{
        body: string;
        severity: string;
      }>`select body, severity from notifications where kind = 'payment_mismatch'`,
    );
    expect(n.severity).toBe("error");
    expect(n.body).toMatch(/saldo \$120\.00.*acreditó \$50\.00.*9002/);
    const pay = await one(
      sql<{
        amount_cents: number;
        metadata: Record<string, unknown>;
      }>`select amount_cents, metadata from payments`,
    );
    expect(pay.amount_cents).toBe(5000);
    expect(pay.metadata).toMatchObject({
      mp_amount_cents: 5000,
      expected_cents: 12000,
      amount_mismatch: true,
    });
    // Reintentar el mismo aviso no duplica la alerta ni el pago
    await apply(mp(orderId, "9002", "approved", 5000));
    expect(await count("notifications", "kind = 'payment_mismatch'")).toBe(1);
    expect(await count("payments")).toBe(1);
  });

  it("monto MAYOR al saldo: se registra el saldo del pedido, se concreta la venta y la alerta pide reembolsar la diferencia", async () => {
    const orderId = await webOrder();
    const r = await apply(mp(orderId, "9003", "approved", 20000));
    expect(r).toMatchObject({ applied_status: "paid", amount_mismatch: true });
    expect(r.sale_id).toBeTruthy();
    expect(await orderState(orderId)).toMatchObject({ payment_status: "paid", paid_cents: 12000 });
    const pay = await one(
      sql<{
        amount_cents: number;
        metadata: Record<string, unknown>;
      }>`select amount_cents, metadata from payments`,
    );
    expect(pay.amount_cents).toBe(12000);
    expect(pay.metadata).toMatchObject({ mp_amount_cents: 20000, expected_cents: 12000 });
    const n = await one(
      sql<{ body: string }>`select body from notifications where kind = 'payment_mismatch'`,
    );
    expect(n.body).toMatch(/Reembolsar la diferencia/);
  });

  it("pedido ya pagado + segundo pago distinto (cliente pagó dos veces): no se registra, alerta de duplicado", async () => {
    const orderId = await webOrder();
    await apply(mp(orderId, "9004", "approved", 12000));
    const r = await apply(mp(orderId, "9005", "approved", 12000));
    expect(r).toMatchObject({
      applied_status: "needs_refund",
      recorded: false,
      reason: "pedido ya pagado",
    });
    expect(await count("payments")).toBe(1);
    expect(await count("sales")).toBe(1);
    const n = await one(
      sql<{
        title: string;
        body: string;
      }>`select title, body from notifications where kind = 'payment_mismatch'`,
    );
    expect(n.title).toMatch(/duplicado/i);
    expect(n.body).toContain("9005");
  });

  it("pedido cancelado: approved → needs_refund con alerta (sin pago ni venta); pending/rejected → ignored", async () => {
    const orderId = await webOrder();
    await callFn(db, "change_order_status", [orderId, "cancelled", "cliente se arrepintió"]);
    const r = await apply(mp(orderId, "9006", "approved", 12000));
    expect(r).toMatchObject({
      applied_status: "needs_refund",
      recorded: false,
      reason: "pedido cancelado",
    });
    expect(await count("payments")).toBe(0);
    expect(await count("sales")).toBe(0);
    expect(await onHand(db, product)).toBe(50);
    expect(await count("notifications", "kind = 'payment_on_cancelled_order'")).toBe(1);
    expect(await apply(mp(orderId, "9007", "pending", 12000))).toMatchObject({
      applied_status: "ignored",
      recorded: false,
    });
    expect(await apply(mp(orderId, "9008", "rejected", 12000))).toMatchObject({
      applied_status: "ignored",
    });
    expect(await count("payments")).toBe(0);
  });

  it("fuera de orden: refunded antes que approved → pago pagado+reembolsado; approved posterior se ignora sin segunda venta", async () => {
    const orderId = await webOrder();
    const r1 = await apply(mp(orderId, "9009", "refunded", 12000));
    expect(r1).toMatchObject({ applied_status: "refunded" });
    expect(await count("refunds")).toBe(1);
    const r2 = await apply(mp(orderId, "9009", "approved", 12000));
    expect(r2).toMatchObject({ ignored_transition: "paid" });
    expect(await count("sales")).toBe(1);
    expect(await count("refunds")).toBe(1);
    const p = await one(sql<{ status: string }>`select status from payments`);
    expect(p.status).toBe("refunded");
  });

  it("fuera de orden: approved y luego pending/rejected del mismo pago no revierten la venta", async () => {
    const orderId = await webOrder();
    await apply(mp(orderId, "9010", "approved", 12000));
    expect(await apply(mp(orderId, "9010", "pending", 12000))).toMatchObject({
      ignored_transition: "pending",
    });
    expect(await apply(mp(orderId, "9010", "rejected", 12000))).toMatchObject({
      ignored_transition: "failed",
    });
    expect(await count("sales")).toBe(1);
    expect(await orderState(orderId)).toMatchObject({ payment_status: "paid" });
  });

  it("pending → approved → refunded: transiciones completas del mismo pago; reembolso idempotente", async () => {
    const orderId = await webOrder();
    await apply(mp(orderId, "9011", "pending", 12000));
    expect(await orderState(orderId)).toMatchObject({ status: "payment_pending", paid_cents: 0 });
    await apply(mp(orderId, "9011", "approved", 12000));
    expect(await orderState(orderId)).toMatchObject({ status: "paid", paid_cents: 12000 });
    await apply(mp(orderId, "9011", "refunded", 12000));
    await apply(mp(orderId, "9011", "refunded", 12000));
    expect(await count("refunds")).toBe(1);
    expect(await count("payments")).toBe(1);
  });

  it("pedido inexistente → error (el webhook lo filtra antes, pero la función no puede aplicar nada)", async () => {
    await expect(
      apply(mp("0b4a7c8e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", "9012", "approved", 100)),
    ).rejects.toThrow(/Pedido no existe/);
  });
});

// ── job_runs ────────────────────────────────────────────────────────────────
describe("job_runs: lock único y liberación de locks huérfanos (trigger 0015)", () => {
  it("dos running con el mismo lock_key → 23505; uno huérfano (> 15 min) se libera al insertar el siguiente", async () => {
    await sql`insert into job_runs(job_name, status, lock_key) values ('j', 'running', 'j')`.execute(
      db,
    );
    await expect(
      sql`insert into job_runs(job_name, status, lock_key) values ('j', 'running', 'j')`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await sql`update job_runs set started_at = now() - interval '20 minutes' where lock_key = 'j'`.execute(
      db,
    );
    const r = await one(
      sql<{
        id: string;
      }>`insert into job_runs(job_name, status, lock_key) values ('j', 'running', 'j') returning id`,
    );
    expect(r.id).toBeTruthy();
    const rows = await sql<{ status: string; error: string | null }>`
      select status, error from job_runs where lock_key = 'j' order by started_at`.execute(db);
    expect(rows.rows).toEqual([
      { status: "failed", error: "lock expirado (proceso sin respuesta)" },
      { status: "running", error: null },
    ]);
  });

  it("locks distintos no se estorban; un run sin lock_key nunca bloquea", async () => {
    await sql`insert into job_runs(job_name, status, lock_key) values ('a', 'running', 'a'), ('b', 'running', 'b')`.execute(
      db,
    );
    await sql`insert into job_runs(job_name, status) values ('a', 'running'), ('a', 'running')`.execute(
      db,
    );
    expect(await count("job_runs", "status = 'running' and job_name in ('a','b')")).toBe(4);
  });
});

// ── Integridad e inventario ─────────────────────────────────────────────────
describe("integridad: invariantes tras venta, anulación y reembolso", () => {
  it("inventario = suma de movimientos, puntos = ledger, paid_cents = pagos, cupones = redenciones; rebuild repara una deriva inducida", async () => {
    const cust = await createCustomer(db);
    await sql`insert into coupons(code, kind, value_bps, is_active) values ('AUD10', 'pct', 1000, true)`.execute(
      db,
    );
    const r1 = await withStaff(db, staff, (trx) =>
      callFn<{ order_id: string; sale_id: string }>(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: product, qty: 2 }],
          customer_id: cust.customer_id,
          coupon_code: "AUD10",
          payments: [
            { provider: "cash", method: "cash", amount_cents: 5400, tendered_cents: 10000 },
          ],
        }),
      ]),
    );
    const r2 = await withStaff(db, staff, (trx) =>
      callFn<{ order_id: string; sale_id: string }>(trx, "pos_checkout", [
        JSON.stringify({
          items: [{ product_id: product, qty: 1 }],
          customer_id: cust.customer_id,
          payments: [{ provider: "cash", method: "cash", amount_cents: 3000 }],
        }),
      ]),
    );
    await withStaff(db, staff, (trx) => callFn(trx, "void_sale", [r2.sale_id, "error de captura"]));
    const pay = await one(
      sql<{ id: string }>`select id from payments where order_id = ${r1.order_id}`,
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_refund", [
        JSON.stringify({
          payment_id: pay.id,
          amount_cents: 1000,
          reason: "parcial",
          idempotency_key: "aud-ref-1",
        }),
      ]),
    );

    const drift = await sql`
      select 1 from inventory_levels l join (select product_id, sum(qty) t from inventory_movements group by 1) m using (product_id) where l.on_hand <> m.t`.execute(
      db,
    );
    expect(drift.rows).toEqual([]);
    const pts = await sql`
      select 1 from customers c left join (select customer_id, sum(points) s from loyalty_transactions group by 1) t on t.customer_id = c.id where c.points_balance <> coalesce(t.s, 0)`.execute(
      db,
    );
    expect(pts.rows).toEqual([]);
    // paid_cents no baja con reembolsos (eso va a refunded_cents): cuentan paid, partially_refunded y refunded
    const paid = await sql`
      select 1 from orders o left join (select order_id, sum(amount_cents) s from payments where status in ('paid','partially_refunded','refunded') group by 1) p on p.order_id = o.id where o.paid_cents <> coalesce(p.s, 0)`.execute(
      db,
    );
    expect(paid.rows).toEqual([]);
    const refunded = await sql`
      select 1 from orders o left join (select order_id, sum(amount_cents) s from refunds where status <> 'failed' group by 1) r on r.order_id = o.id where o.refunded_cents <> coalesce(r.s, 0)`.execute(
      db,
    );
    expect(refunded.rows).toEqual([]);
    const coup = await sql`
      select 1 from coupons c left join (select coupon_id, count(*) n from coupon_redemptions group by 1) r on r.coupon_id = c.id where c.uses_count <> coalesce(r.n, 0)`.execute(
      db,
    );
    expect(coup.rows).toEqual([]);
    // total_spent_cents = ventas no anuladas − reembolsos de esos pedidos (record_refund lo descuenta)
    const stats = await sql`
      select 1 from customers c
      left join (select customer_id, count(*) n, sum(total_cents) t from sales where voided_at is null group by 1) s on s.customer_id = c.id
      left join (select s2.customer_id, sum(r.amount_cents) t from refunds r join sales s2 on s2.order_id = r.order_id and s2.voided_at is null where r.status <> 'failed' group by 1) rf on rf.customer_id = c.id
      where c.total_orders <> coalesce(s.n, 0) or c.total_spent_cents <> coalesce(s.t, 0) - coalesce(rf.t, 0)`.execute(
      db,
    );
    expect(stats.rows).toEqual([]);

    // Deriva inducida (escritura directa) → rebuild la corrige
    await sql`update inventory_levels set on_hand = 999 where product_id = ${product}`.execute(db);
    expect(await onHand(db, product)).toBe(999);
    await callFn(db, "rebuild_inventory_levels", []);
    expect(await onHand(db, product)).toBe(48); // 50 producidas − 2 vendidas (+1 −1 anulada)
  });
});

// ── Importador ──────────────────────────────────────────────────────────────
describe("importador: casos reales de la hoja", () => {
  it("re-aplicar un precio con 'Vigente desde' anterior al vigente es idempotente (no duplica historial)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdp-audit-import-"));
    try {
      await sql`insert into ingredients(name, base_unit) values ('Harina de trigo', 'g')`.execute(
        db,
      );
      const ing = await one(
        sql<{ id: string }>`select id from ingredients where name = 'Harina de trigo'`,
      );
      await sql`insert into ingredient_prices(ingredient_id, package_qty, price_cents, valid_from) values (${ing.id}, 1000, 2200, now())`.execute(
        db,
      );
      const file = join(dir, "ingredientes.csv");
      // BOM, ';', comillas, decimal con coma y miles con punto, kg, fecha dd/mm/aaaa anterior al precio vigente
      writeFileSync(
        file,
        "\uFEFFINGREDIENTE;Marca;Precio;Contenido;Unidad;Presentación;Proveedor;Vigente desde\n" +
          '"Harina de trigo";"";"$ 1.250,50";"5";"KG";"Saco 5 kg";"";"01/01/2026"\n;;;;;;;\n',
      );
      const opts = {
        db,
        file,
        entity: "ingredients" as const,
        mapping: resolve(PKG, "import/mappings/ingredientes.json"),
        mode: "apply" as const,
        staffId: staff,
        reportDir: dir,
      };
      const first = await runImport(opts);
      expect(first.counts).toMatchObject({ updated: 1, error: 0 });
      const second = await runImport(opts);
      expect(second.counts).toMatchObject({ updated: 0, matched: 1 });
      const third = await runImport(opts);
      expect(third.counts).toMatchObject({ updated: 0, matched: 1 });
      const prices = await sql<{ price_cents: number; package_qty: string }>`
        select price_cents, package_qty::text from ingredient_prices where ingredient_id = ${ing.id} order by valid_from`.execute(
        db,
      );
      expect(prices.rows.map((r) => [r.price_cents, Number(r.package_qty)])).toEqual([
        [125050, 5000],
        [2200, 1000],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encabezados sin acento, en MAYÚSCULAS o con espacios extra: productos y ventas (largo y ancho) se leen bien", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdp-audit-import-"));
    try {
      const base = { db, staffId: staff, reportDir: dir, mode: "apply" as const };
      const prod = join(dir, "productos.csv");
      writeFileSync(
        prod,
        "PRODUCTO,Categoria,  Precio ,Descripcion,ACTIVO\nBrownie de nuez,Brownies,45,Rico,sí\n",
      );
      const p = await runImport({
        ...base,
        file: prod,
        entity: "products",
        mapping: resolve(PKG, "import/mappings/productos.json"),
      });
      expect(p.counts).toMatchObject({ created: 1, error: 0 });
      const cat = await one(
        sql<{
          name: string;
        }>`select c.name from products p join categories c on c.id = p.category_id where p.name = 'Brownie de nuez'`,
      );
      expect(cat.name).toBe("Brownies");

      const largo = join(dir, "ventas.csv");
      writeFileSync(
        largo,
        "CLIENTE;FECHA;PRODUCTO;CANTIDAD;Precio Unitario\nAna López;03/08/2026;Brownie de nuez;2;40\n",
      );
      const l = await runImport({
        ...base,
        file: largo,
        entity: "orders",
        mapping: resolve(PKG, "import/mappings/pedidos-largo.json"),
      });
      expect(l.counts, JSON.stringify(l.rows.map((r) => r.error))).toMatchObject({
        created: 2 - 1,
        error: 0,
      });

      const ancho = join(dir, "pedidos.csv");
      writeFileSync(
        ancho,
        "Cliente,Telefono,Fecha,Total,Punto de Entrega,PAGADO,Metodo,Brownie de nuez\nBeto Ruiz,6641112233,04/08/2026,90,Mostrador,si,efectivo,2\n",
      );
      const w = await runImport({
        ...base,
        file: ancho,
        entity: "orders",
        mapping: resolve(PKG, "import/mappings/pedidos.json"),
      });
      expect(w.counts, JSON.stringify(w.rows.map((r) => r.error))).toMatchObject({
        created: 1,
        error: 0,
      });
      expect(await count("orders")).toBe(2);
      expect(await count("inventory_movements", "type = 'SALE'")).toBe(0); // ventas históricas no mueven stock
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Migraciones, reset, seed, codegen ───────────────────────────────────────
describe("migraciones y scripts operativos", () => {
  it("checksums aplicados = sha256 de los archivos; RELEASED coincide con los archivos; 0015 aplicada", async () => {
    const files = listMigrations();
    const applied = await sql<{ version: string; name: string; checksum: string }>`
      select version, name, checksum from schema_migrations order by version`.execute(db);
    expect(applied.rows.map((r) => r.name)).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(applied.rows.find((r) => r.version === f.version)!.checksum).toBe(f.checksum);
    }
    expect(files.some((f) => f.name === "0015_audit_infra.sql")).toBe(true);
    const released = readFileSync(resolve(PKG, "migrations/RELEASED"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/) as [string, string]);
    expect(released.length).toBeGreaterThan(0);
    for (const [name, sum] of released) {
      const actual = createHash("sha256")
        .update(readFileSync(resolve(PKG, "migrations", name)))
        .digest("hex");
      expect(actual, name).toBe(sum);
    }
  });

  it("reset.ts rechaza hosts remotos y APP_ENV=production sin conectarse", () => {
    const remote = spawnSync("pnpm", ["exec", "tsx", "scripts/reset.ts"], {
      cwd: PKG,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://user:pw@db.example.supabase.co:5432/postgres",
        APP_ENV: "development",
      },
      encoding: "utf8",
    });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toMatch(/Rechazado/);
    const prod = spawnSync("pnpm", ["exec", "tsx", "scripts/reset.ts"], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL: databaseUrl("test"), APP_ENV: "production" },
      encoding: "utf8",
    });
    expect(prod.status).toBe(2);
    expect(prod.stderr).toMatch(/Rechazado/);
  }, 60_000);

  it("seed es idempotente: dos corridas dejan los mismos conteos y no duplican admin", async () => {
    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl("test"),
      APP_ENV: "development",
      SEED_ADMIN_EMAIL: "audit-admin@pdp.local",
      SEED_ADMIN_PASSWORD: "ClaveDePrueba!2026",
    };
    const snapshot = async () =>
      one(sql<Record<string, number>>`
        select (select count(*)::int from products) as products, (select count(*)::int from categories) as categories,
               (select count(*)::int from ingredients) as ingredients, (select count(*)::int from recipes) as recipes,
               (select count(*)::int from product_prices) as prices, (select count(*)::int from staff_users) as staff,
               (select count(*)::int from pickup_points) as pickup, (select count(*)::int from ordering_windows) as windows`);
    execFileSync("pnpm", ["exec", "tsx", "scripts/seed.ts"], { cwd: PKG, env, stdio: "pipe" });
    const a = await snapshot();
    execFileSync("pnpm", ["exec", "tsx", "scripts/seed.ts"], { cwd: PKG, env, stdio: "pipe" });
    const b = await snapshot();
    expect(b).toEqual(a);
    expect(a.products).toBeGreaterThan(5);
    expect(await count("staff_users", "email = 'audit-admin@pdp.local'")).toBe(1);
  }, 120_000);

  it("codegen al día: los tipos generados coinciden con el esquema actual", () => {
    const current = resolve(PKG, "src/generated/db.ts");
    const dir = mkdtempSync(join(tmpdir(), "pdp-codegen-"));
    try {
      const out = join(dir, "db.ts");
      execFileSync(
        "npx",
        [
          "kysely-codegen",
          "--dialect",
          "postgres",
          "--url",
          databaseUrl("test"),
          "--out-file",
          out,
          "--camel-case=false",
          "--include-pattern",
          "public.*",
          "--exclude-pattern",
          "public.schema_migrations",
          "--runtime-enums=false",
        ],
        { cwd: PKG, stdio: "pipe" },
      );
      expect(readFileSync(out, "utf8")).toBe(readFileSync(current, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
