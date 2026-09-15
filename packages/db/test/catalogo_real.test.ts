/**
 * Carga del catálogo real (packages/db/import/catalogo, scripts/catalogo-real.sh):
 * retira los productos demo sin borrarlos, crea los de la hoja con su precio, alinea Croissant Dubai
 * y es idempotente (una segunda corrida no duplica ni desactiva productos reales que heredan un slug demo).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../scripts/import/run.ts";
import { createProduct, createStaff, sql, testDb, truncateAll } from "./helpers.ts";

const { db, pool } = testDb();
const DIR = resolve(import.meta.dirname, "../import/catalogo");
const MAP = (f: string) => resolve(import.meta.dirname, "../import/mappings", f);
const reportDir = mkdtempSync(join(tmpdir(), "pdp-catalogo-"));
let staff: string;

/** El archivo es para psql: se quitan las metainstrucciones (\set) y se ejecuta en una transacción. */
async function preparar() {
  const text = readFileSync(join(DIR, "2026-09-15-1-preparar.sql"), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("\\"))
    .join("\n");
  await db.transaction().execute((trx) => sql.raw(text).execute(trx));
}

async function cargar() {
  await preparar();
  const products = await runImport({
    db,
    file: join(DIR, "2026-09-15-catalogo-real.csv"),
    entity: "products",
    mapping: MAP("catalogo-real.json"),
    mode: "apply",
    staffId: staff,
    reportDir,
  });
  const prices = await runImport({
    db,
    file: join(DIR, "2026-09-15-precios.csv"),
    entity: "prices",
    mapping: MAP("catalogo-real-precios.json"),
    mode: "apply",
    staffId: staff,
    reportDir,
  });
  return { products, prices };
}

type P = {
  name: string;
  slug: string;
  is_active: boolean;
  show_on_web: boolean;
  is_featured: boolean;
  tags: string[];
  category: string | null;
  unit_label: string;
  price: number | null;
};
async function bySlug(slug: string): Promise<P | undefined> {
  return (
    await sql<P>`select p.name, p.slug, p.is_active, p.show_on_web, p.is_featured, p.tags, c.slug as category,
                        p.unit_label, current_price_cents(p.id, 'web') as price
                   from products p left join categories c on c.id = p.category_id
                  where p.slug = ${slug}`.execute(db)
  ).rows[0];
}

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  // Estado de producción: productos demo del seed (con el mismo slug y nombre) + Croissant Dubai.
  await createProduct(db, "Galleta de chispas de chocolate", 3500, { slug: "galleta-chispas" });
  await createProduct(db, "Rol de canela", 5500, { slug: "rol-canela" });
  const dubai = await createProduct(db, "Croissant Dubai", 12000, { slug: "croissant-dubai" });
  await sql`update products set tags = '{nuevo}', is_featured = false where id = ${dubai}`.execute(
    db,
  );
  // Mismo slug que una demo pero otro nombre: NO es demo y no se toca.
  await createProduct(db, "Concha especial de la casa", 3000, { slug: "concha-vainilla" });
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("catálogo real 2026-09-15", () => {
  it("retira las demo sin borrar, crea los productos de la hoja y alinea Croissant Dubai", async () => {
    const { products, prices } = await cargar();
    expect(products.status).toBe("applied");
    expect(products.counts).toMatchObject({ created: 33, matched: 1, skipped: 0, error: 0 });
    expect(prices.counts).toMatchObject({ updated: 1, error: 0 });

    const demo = await bySlug("galleta-chispas-demo");
    expect(demo).toMatchObject({
      name: "Galleta de chispas de chocolate",
      is_active: false,
      show_on_web: false,
    });
    expect(await bySlug("rol-canela-demo")).toMatchObject({ is_active: false });
    expect(await bySlug("concha-vainilla")).toMatchObject({
      name: "Concha especial de la casa",
      is_active: true,
    });

    expect(await bySlug("galleta-chispas")).toMatchObject({
      name: "Galleta Chispas",
      is_active: true,
      category: "galletas",
      price: 5400,
    });
    expect(await bySlug("croissant-dubai")).toMatchObject({
      is_active: true,
      is_featured: true,
      tags: [],
      category: "croissants",
      price: 11500,
    });
    expect(await bySlug("docena-mini-chocolatine")).toMatchObject({
      unit_label: "docena",
      price: 36500,
    });
    expect(await bySlug("croncha")).toMatchObject({ category: "temporada", price: 7600 });
    // Sin precio en la hoja: queda creado pero inactivo (no se inventan precios).
    expect(await bySlug("polvorones")).toMatchObject({ is_active: false, price: null });
    expect(await bySlug("kouign-amann-guayaba")).toMatchObject({ is_active: false });

    const web = await sql<{ n: number }>`select count(*)::int as n from products
      where is_active and show_on_web and current_price_cents(id, 'web') is not null`.execute(db);
    expect(web.rows[0]!.n).toBe(27); // 26 de la hoja con precio + la concha ajena a la demo
    const featured = await sql<{
      slug: string;
    }>`select slug from products where is_featured order by slug`.execute(db);
    expect(featured.rows.map((r) => r.slug)).toEqual([
      "croissant-chocolate-almendra",
      "croissant-dubai",
      "croissant-pistache",
      "croissant-s-mores",
    ]);
  });

  it("repetir la carga no duplica ni desactiva los productos reales que heredaron un slug demo", async () => {
    await cargar();
    const again = await cargar();
    expect(again.products.counts).toMatchObject({ created: 0, matched: 34, error: 0 });
    expect(again.prices.counts).toMatchObject({ updated: 0, error: 0 });
    expect(await bySlug("galleta-chispas")).toMatchObject({
      name: "Galleta Chispas",
      is_active: true,
    });
    expect(await bySlug("galleta-chispas-demo-demo")).toBeUndefined();
    const prices = await sql<{ n: number }>`select count(*)::int as n from product_prices pp
      join products p on p.id = pp.product_id where p.slug = 'croissant-dubai'`.execute(db);
    expect(prices.rows[0]!.n).toBe(2); // el precio demo cerrado + el de la hoja
  });
});
