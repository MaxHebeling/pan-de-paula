import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../scripts/import/run.ts";
import { parseCsvText } from "../scripts/import/parse.ts";
import { parseNumber, toDate, toMoneyCents, toPhone } from "../scripts/import/transforms.ts";
import { similarity } from "../scripts/import/normalize.ts";
import {
  callFn,
  createStaff,
  createProduct,
  onHand,
  sql,
  testDb,
  truncateAll,
  withStaff,
} from "./helpers.ts";

const { db, pool } = testDb();
const FX = (f: string) => resolve(import.meta.dirname, "fixtures", f);
const MAP = (f: string) => resolve(import.meta.dirname, "../import/mappings", f);
const reportDir = mkdtempSync(join(tmpdir(), "pdp-import-"));
let staff: string;

const count = async (table: string, where = "true") =>
  (
    await sql<{
      n: number;
    }>`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(where)}`.execute(db)
  ).rows[0]!.n;
const run = (
  entity: Parameters<typeof runImport>[0]["entity"],
  file: string,
  mapping: string,
  mode: "dry-run" | "apply",
  extra: Partial<Parameters<typeof runImport>[0]> = {},
) =>
  runImport({
    db,
    file: FX(file),
    entity,
    mapping: MAP(mapping),
    mode,
    staffId: staff,
    reportDir,
    ...extra,
  });

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("transformaciones", () => {
  it("dinero: '$1,234.50' → 123450, '26,50' → 2650, '1.234,50' → 123450", () => {
    expect(toMoneyCents("$1,234.50")).toBe(123450);
    expect(toMoneyCents("26,50")).toBe(2650);
    expect(toMoneyCents("1.234,50")).toBe(123450);
    expect(toMoneyCents("1,234")).toBe(123400);
    expect(toMoneyCents(" ")).toBeNull();
    expect(() => toMoneyCents("abc")).toThrow(/Número inválido/);
  });
  it("cantidades y fechas", () => {
    expect(parseNumber("1.808")).toBe(1.808);
    expect(toDate("12/03/2026")).toBe("2026-03-12");
    expect(toDate("2026-03-12")).toBe("2026-03-12");
    expect(toDate("12 de marzo de 2026")).toBe("2026-03-12");
    expect(toDate("3/12/2026", { date_format: "mm/dd/yyyy" })).toBe("2026-03-12");
    expect(() => toDate("31/02/2026")).toThrow(/Fecha inválida/);
  });
  it("teléfonos con espacios y lada +52", () => {
    expect(toPhone("664 123 45 67")).toBe("6641234567");
    expect(toPhone("+52 664 987 6543")).toBe("6649876543");
    expect(toPhone("(664) 123-4567")).toBe("6641234567");
    expect(() => toPhone("123")).toThrow(/Teléfono inválido/);
  });
  it("CSV: BOM, ';', comillas y saltos de línea", () => {
    const rows = parseCsvText('﻿A;B\n"x;y";"di""jo"\n1;"dos\nlíneas"\n');
    expect(rows).toEqual([
      ["A", "B"],
      ["x;y", 'di"jo'],
      ["1", "dos\nlíneas"],
    ]);
  });
  it("similitud: typo se parece, productos distintos no tanto", () => {
    expect(similarity("Mantequilla", "Mantequila")).toBeGreaterThan(0.7);
    expect(similarity("Harina de trigo", "Harina de Trigo ")).toBe(1);
    expect(similarity("Croissant de mantequilla", "Croissant de chocolate")).toBeLessThan(0.7);
  });
});

describe("ingredientes", () => {
  it("dry-run registra el batch y las filas pero no escribe ingredientes", async () => {
    const res = await run("ingredients", "ingredientes.csv", "ingredientes.json", "dry-run");
    expect(res.status).toBe("dry_run");
    expect(res.counts).toEqual({ created: 4, updated: 0, matched: 0, skipped: 1, error: 1 });
    expect(await count("ingredients")).toBe(0);
    expect(await count("import_batches", "status = 'dry_run'")).toBe(1);
    expect(await count("import_rows")).toBe(6);
    expect(res.reportPath).toMatch(/\.md$/);
  });

  it("apply crea, convierte kg→g, parsea '$1,234.50' y re-apply no duplica", async () => {
    const res = await run("ingredients", "ingredientes.csv", "ingredientes.json", "apply");
    expect(res.status).toBe("applied");
    expect(res.counts.created).toBe(4);
    expect(res.counts.skipped).toBe(1); // "Harina de Trigo" duplicada en el archivo
    expect(res.counts.error).toBe(1); // "Sal" sin unidad
    const harina = (
      await sql<{
        base_unit: string;
        package_qty: string;
        price_cents: number;
        unit_cost: string;
        supplier: string | null;
      }>`
        select i.base_unit, p.package_qty::text, p.price_cents, p.unit_cost::text, s.name as supplier
        from ingredients i join ingredient_prices p on p.ingredient_id = i.id left join suppliers s on s.id = i.supplier_id
        where i.name = 'Harina de trigo'`.execute(db)
    ).rows[0]!;
    expect(harina.base_unit).toBe("g");
    expect(Number(harina.package_qty)).toBe(50000);
    expect(harina.price_cents).toBe(123450);
    expect(Number(harina.unit_cost)).toBeCloseTo(1234.5 / 50000, 8);
    expect(harina.supplier).toBe("Molinos del Norte");
    const leche = (
      await sql<{
        package_qty: string;
        price_cents: number;
      }>`select p.package_qty::text, p.price_cents from ingredients i join ingredient_prices p on p.ingredient_id = i.id where i.name = 'Leche'`.execute(
        db,
      )
    ).rows[0]!;
    expect(Number(leche.package_qty)).toBe(1000);
    expect(leche.price_cents).toBe(2650);
    const salRow = res.rows.find((r) => r.raw.Ingrediente === "Sal")!;
    expect(salRow.action).toBe("error");
    expect(salRow.error).toMatch(/unidad/i);
    expect(await count("import_rows", "action = 'error'")).toBe(1);

    const again = await run("ingredients", "ingredientes.csv", "ingredientes.json", "apply");
    expect(again.counts.matched).toBe(4);
    expect(again.counts.created).toBe(0);
    expect(await count("ingredients")).toBe(4);
    expect(await count("ingredient_prices")).toBe(4);
  });

  it("similar se omite con motivo; precio nuevo agrega historial", async () => {
    await run("ingredients", "ingredientes.csv", "ingredientes.json", "apply");
    const res = await run("ingredients", "ingredientes-2.csv", "ingredientes.json", "apply");
    const typo = res.rows.find((r) => r.raw.Ingrediente === "Mantequila")!;
    expect(typo.action).toBe("skipped");
    expect(typo.error).toMatch(/Posible duplicado.*Mantequilla/);
    const harina = res.rows.find((r) => r.raw.Ingrediente === "Harina de trigo")!;
    expect(harina.action).toBe("updated");
    expect(await count("ingredient_prices")).toBe(6); // 4 iniciales + Harina (nuevo precio) + Azúcar
    expect(await count("ingredients", "name = 'Mantequila'")).toBe(0);
    expect(await count("ingredients", "name = 'Azúcar'")).toBe(1);
    const cost = (
      await sql<{
        c: string;
      }>`select ingredient_unit_cost(id)::text as c from ingredients where name = 'Harina de trigo'`.execute(
        db,
      )
    ).rows[0]!.c;
    expect(Number(cost)).toBeCloseTo(1300 / 50000, 8);
  });
});

describe("productos, recetas y precios", () => {
  it("productos: crea categoría por nombre, slug y precio regular; re-apply matched", async () => {
    const res = await run("products", "productos.csv", "productos.json", "apply");
    expect(res.counts.created).toBe(4);
    expect(await count("categories")).toBe(3);
    const p = (
      await sql<{ slug: string; is_active: boolean; category: string; price: number }>`
        select p.slug, p.is_active, c.name as category, current_price_cents(p.id, 'pos') as price
        from products p join categories c on c.id = p.category_id where p.name = 'Croissant de chocolate'`.execute(
        db,
      )
    ).rows[0]!;
    expect(p).toEqual({
      slug: "croissant-de-chocolate",
      is_active: true,
      category: "Croissants",
      price: 5500,
    });
    expect(await count("products", "name = 'Rol de canela' and is_active = false")).toBe(1);
    const again = await run("products", "productos.csv", "productos.json", "apply");
    expect(again.counts).toMatchObject({ created: 0, matched: 4 });
    expect(await count("products")).toBe(4);
    expect(await count("product_prices")).toBe(4);
  });

  it("recetas: convierte unidades, ingrediente inexistente → error de la receta completa; strict revierte todo", async () => {
    await run("ingredients", "ingredientes.csv", "ingredientes.json", "apply");
    await run("products", "productos.csv", "productos.json", "apply");
    const strict = await run("recipes", "recetas.csv", "recetas.json", "apply", { strict: true });
    expect(strict.status).toBe("failed");
    expect(await count("recipes")).toBe(0);
    expect(await count("import_batches", "status = 'failed'")).toBe(1);

    const res = await run("recipes", "recetas.csv", "recetas.json", "apply");
    expect(res.status).toBe("applied");
    expect(res.counts.created).toBe(3);
    expect(res.counts.error).toBe(2);
    const chocoRows = res.rows.filter((r) => r.raw.Producto === "Croissant de chocolate");
    expect(chocoRows.every((r) => r.action === "error")).toBe(true);
    expect(chocoRows.some((r) => /Chocolate semiamargo.*no existe/.test(r.error ?? ""))).toBe(true);
    const lines = (
      await sql<{
        name: string;
        qty: string;
      }>`select i.name, ri.qty::text from recipe_items ri join ingredients i on i.id = ri.ingredient_id order by ri.sort_order`.execute(
        db,
      )
    ).rows;
    expect(lines.map((l) => [l.name, Number(l.qty)])).toEqual([
      ["Harina de trigo", 1000],
      ["Mantequilla", 500],
      ["Huevo", 2],
    ]);
    const cost = (
      await sql<{
        c: number;
      }>`select product_cost_cents(id) as c from products where name = 'Croissant de mantequilla'`.execute(
        db,
      )
    ).rows[0]!.c;
    // (1000 g × 0.02469 + 500 g × 0.221239 + 2 pz × 3.16667) = $141.64 por lote / 12 piezas = $11.80
    expect(cost).toBe(1180);
    const again = await run("recipes", "recetas.csv", "recetas.json", "apply");
    expect(again.counts.matched).toBe(3);
    expect(await count("recipe_items")).toBe(3);
  });

  it("precios: nuevo regular cierra el anterior, igual → matched, producto inexistente → error", async () => {
    await run("products", "productos.csv", "productos.json", "apply");
    const res = await run("prices", "precios.csv", "precios.json", "apply");
    expect(res.counts).toMatchObject({ updated: 1, matched: 1, created: 1, error: 1 });
    const cur = (
      await sql<{
        p: number;
      }>`select current_price_cents(id, 'pos') as p from products where name = 'Croissant de mantequilla'`.execute(
        db,
      )
    ).rows[0]!.p;
    expect(cur).toBe(4800);
    const closed = await count("product_prices", "price_cents = 4500 and valid_to is not null");
    expect(closed).toBe(1);
    const galleta = (
      await sql<{
        pos: number;
        web: number;
      }>`select current_price_cents(id, 'pos') as pos, current_price_cents(id, 'web') as web from products where name = 'Galleta de chispas'`.execute(
        db,
      )
    ).rows[0]!;
    expect(galleta).toEqual({ pos: 3800, web: 3500 });
    const again = await run("prices", "precios.csv", "precios.json", "apply");
    expect(again.counts.matched).toBe(3);
  });
});

describe("clientes", () => {
  it("normaliza teléfonos, omite repetidos y similares, re-apply matched", async () => {
    const res = await run("customers", "clientes.csv", "clientes.json", "apply");
    expect(res.counts).toEqual({ created: 3, updated: 0, matched: 0, skipped: 1, error: 1 });
    const ana = (
      await sql<{
        phone: string;
        source: string;
        birthday: Date;
        marketing_consent: boolean;
      }>`select phone::text, source, birthday, marketing_consent from customers where full_name = 'Ana López'`.execute(
        db,
      )
    ).rows[0]!;
    expect(ana.phone).toBe("6641234567");
    expect(ana.source).toBe("import");
    expect(ana.marketing_consent).toBe(true);
    expect(await count("customers", "phone = '6649876543'")).toBe(1);
    expect(res.rows.find((r) => r.raw.Cliente === "Ana Lopez")!.error).toMatch(
      /repetido en el archivo/,
    );
    expect(res.rows.find((r) => r.raw.Cliente === "Pedro Sin Contacto")!.action).toBe("error");

    const res2 = await run("customers", "clientes-2.csv", "clientes.json", "apply");
    const anaDup = res2.rows.find((r) => r.raw.Cliente === "Ana Lopez")!;
    expect(anaDup.action).toBe("skipped");
    expect(anaDup.error).toMatch(/Posible duplicado.*Ana López/);
    expect(res2.rows.find((r) => r.raw.Cliente === "Luis Perez")!.action).toBe("matched");
    expect(res2.rows.find((r) => r.raw.Cliente === "Carla Ruiz")!.action).toBe("created");
    expect(await count("customers")).toBe(4);
    expect(await count("domain_events", "event_type = 'CUSTOMER_REGISTERED'")).toBe(4);
  });
});

describe("pedidos históricos", () => {
  let croissant: string;
  beforeEach(async () => {
    croissant = await createProduct(db, "Croissant de mantequilla", 4500);
    await createProduct(db, "Croissant de chocolate", 5500);
    await createProduct(db, "Galleta de chispas", 3500);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [croissant, 20, null, null]),
    );
  });

  it("XLSX ancho: crea pedido+venta+pago sin tocar inventario ni puntos; re-apply no duplica", async () => {
    const dry = await run("orders", "pedidos.xlsx", "pedidos.json", "dry-run");
    expect(dry.counts).toEqual({ created: 3, updated: 0, matched: 0, skipped: 1, error: 1 });
    expect(dry.rows.find((r) => r.rowNumber === 6)!.error).toMatch(/total declarado/i);
    expect(await count("orders")).toBe(0);

    const res = await run("orders", "pedidos.xlsx", "pedidos.json", "apply");
    expect(res.status).toBe("applied");
    expect(res.counts).toEqual({ created: 3, updated: 0, matched: 0, skipped: 1, error: 1 }); // fila 6: total mayor a los ítems
    expect(res.rows.find((r) => r.rowNumber === 6)!.error).toMatch(/total declarado/i);
    expect(res.rows.find((r) => r.rowNumber === 5)!.error).toMatch(/Sin productos/);

    expect(await count("orders")).toBe(3);
    expect(await count("sales")).toBe(2);
    expect(await count("payments")).toBe(2);
    expect(await count("inventory_movements", "type = 'SALE'")).toBe(0);
    expect(await onHand(db, croissant)).toBe(20);
    expect(await count("loyalty_transactions")).toBe(0);
    expect(await count("domain_events", "event_type = 'HISTORICAL_SALE_IMPORTED'")).toBe(3);
    expect(
      await count(
        "domain_events",
        "event_type in ('PRODUCT_SOLD','ORDER_PAID','LOYALTY_POINTS_EARNED')",
      ),
    ).toBe(0);

    const ana = (
      await sql<{
        total_cents: number;
        folio: string;
        status: string;
        day: string;
        method: string;
        source_ref: string;
        customer_orders: number;
        spent: number;
        first: string;
      }>`
        select o.total_cents, o.folio, o.status::text, to_char(s.sold_at at time zone 'America/Tijuana', 'YYYY-MM-DD') as day, p.method::text, o.source_ref,
               c.total_orders as customer_orders, c.total_spent_cents::int as spent, to_char(c.first_purchase_at at time zone 'America/Tijuana', 'YYYY-MM-DD') as first
        from orders o join sales s on s.order_id = o.id join payments p on p.order_id = o.id join customers c on c.id = o.customer_id
        where o.customer_name = 'Ana López'`.execute(db)
    ).rows[0]!;
    expect(ana.total_cents).toBe(14500);
    expect(ana.folio).toMatch(/^PDP-2026-/);
    expect(ana.status).toBe("completed");
    expect(ana.day).toBe("2026-03-12");
    expect(ana.method).toBe("cash");
    expect(ana.source_ref).toBe(`import:${res.importKey}:2`);
    expect(ana.customer_orders).toBe(1);
    expect(ana.spent).toBe(14500);
    expect(ana.first).toBe("2026-03-12");

    const luis = (
      await sql<{
        status: string;
        payment_status: string;
        discount_cents: number;
        total_cents: number;
      }>`select status::text, payment_status::text, discount_cents, total_cents from orders where customer_name = 'Luis Pérez'`.execute(
        db,
      )
    ).rows[0]!;
    expect(luis).toEqual({
      status: "confirmed",
      payment_status: "pending",
      discount_cents: 1500,
      total_cents: 20000,
    });

    const nuevo = (
      await sql<{
        source: string;
        method: string;
      }>`select c.source, p.method::text from customers c join orders o on o.customer_id = c.id join payments p on p.order_id = o.id where c.full_name = 'Nuevo Cliente'`.execute(
        db,
      )
    ).rows[0]!;
    expect(nuevo).toEqual({ source: "import", method: "mercadopago" });
    expect(await count("customers")).toBe(2); // Ana (creada por teléfono) + Nuevo Cliente; Luis sin contacto queda como snapshot

    const again = await run("orders", "pedidos.xlsx", "pedidos.json", "apply");
    expect(again.counts.matched).toBe(3);
    expect(again.counts.created).toBe(0);
    expect(await count("orders")).toBe(3);
    expect(await count("sales")).toBe(2);
    expect(await count("customers")).toBe(2);
    expect(await onHand(db, croissant)).toBe(20);
  });

  it("CSV largo: agrupa por cliente+fecha y respeta precio unitario de la hoja", async () => {
    const res = await run("orders", "pedidos-largo.csv", "pedidos-largo.json", "apply");
    expect(res.counts.created).toBe(3);
    expect(await count("orders")).toBe(2);
    const anaRows = res.rows.filter((r) => r.raw.Cliente === "Ana López");
    expect(new Set(anaRows.map((r) => r.targetId)).size).toBe(1);
    const totals = (
      await sql<{
        customer_name: string;
        total_cents: number;
      }>`select customer_name, total_cents from orders order by total_cents`.execute(db)
    ).rows;
    expect(totals).toEqual([
      { customer_name: "Luis Pérez", total_cents: 5500 },
      { customer_name: "Ana López", total_cents: 11000 },
    ]);
    const cost = await count("order_items", "unit_price_cents = 4000 and qty = 2");
    expect(cost).toBe(1);
  });

  it("import_historical_sale es idempotente por source_ref y nunca mueve stock", async () => {
    const payload = {
      source_ref: "import:test:1",
      sold_date: "2026-01-15",
      items: [{ product_id: croissant, qty: 3 }],
      payment_method: "transfer",
    };
    const a = await withStaff(db, staff, (trx) =>
      callFn<{ order_id: string; sale_id: string; duplicate: boolean; total_cents: number }>(
        trx,
        "import_historical_sale",
        [JSON.stringify(payload)],
      ),
    );
    const b = await withStaff(db, staff, (trx) =>
      callFn<{ order_id: string; duplicate: boolean }>(trx, "import_historical_sale", [
        JSON.stringify(payload),
      ]),
    );
    expect(a.duplicate).toBe(false);
    expect(a.total_cents).toBe(13500);
    expect(b.duplicate).toBe(true);
    expect(b.order_id).toBe(a.order_id);
    expect(await count("sales")).toBe(1);
    expect(await count("payments", "provider = 'manual' and method = 'transfer'")).toBe(1);
    expect(await onHand(db, croissant)).toBe(20);
    expect(await count("inventory_movements")).toBe(1); // solo la producción del beforeEach
    await expect(
      withStaff(db, staff, (trx) =>
        callFn(trx, "import_historical_sale", [JSON.stringify({ ...payload, source_ref: "x" })]),
      ),
    ).rejects.toThrow(/source_ref/);
  });
});
