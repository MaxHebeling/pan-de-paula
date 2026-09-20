import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Un producto especial (temporal) se comporta en el sitio público EXACTAMENTE como cualquier otro:
 * aparece en el menú mientras está activo y con precio, se marca "Agotado" cuando su stock llega a
 * cero (se crea sin preventa) y desaparece al desactivarlo — sin reglas nuevas en apps/web.
 *
 * Requiere el sitio corriendo (E2E_WEB_URL) y DATABASE_URL apuntando a la MISMA base migrada.
 */
const SHOTS = process.env.SHOTS_DIR ?? path.join("test-results", "especiales-web");

let db: Database;
let pool: { end: () => Promise<void> };

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL para la prueba de especiales");
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 2 }));
});
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Alta igual que la del CRM: producto especial + precio regular + stock inicial. */
async function altaEspecial(nombre: string, priceCents: number, stock: number) {
  const slug = `${nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
  const r = await sql<{ id: string }>`
    insert into products(name, slug, is_temporary, is_active, show_on_web, show_on_pos,
                         track_stock, allow_preorder, requires_preorder, unit_label, sort_order)
    values (${nombre}, ${slug}, true, true, true, true, true, false, false, 'pieza', 900)
    returning id`.execute(db);
  const id = r.rows[0]!.id;
  await sql`select set_regular_price(${id}, 'all'::price_channel, ${priceCents}, 'Alta de producto especial')`.execute(
    db,
  );
  if (stock > 0)
    await sql`select record_stock_correction(${id}::uuid, ${stock}::numeric, 'initial', 'alta de producto especial')`.execute(
      db,
    );
  return { id, slug };
}

const ajustarStock = async (id: string, delta: number) =>
  sql`select record_stock_correction(${id}::uuid, ${delta}::numeric, 'difference', 'e2e')`.execute(
    db,
  );

const activar = (id: string, activo: boolean) =>
  sql`update products set is_active = ${activo} where id = ${id}`.execute(db);

async function capturar(page: import("@playwright/test").Page, nombre: string) {
  await mkdir(SHOTS, { recursive: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, `${nombre}-${width}.png`), fullPage: true });
  }
}

test("el especial aparece, se agota y desaparece del catálogo público según su estado", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const nombre = `Rosca de Reyes ${testInfo.project.name} ${Date.now().toString(36)}`;
  const p = await altaEspecial(nombre, 45000, 12);

  // ── Activo y con stock: está en el menú y se puede agregar ───────────────
  await page.goto("/menu");
  await expect(page.getByRole("link", { name: nombre }).first()).toBeVisible();
  await page.goto(`/producto/${p.slug}`);
  await expect(page.getByTestId("product-title")).toHaveText(nombre);
  await expect(page.getByTestId("add-to-cart")).toBeEnabled();
  await capturar(page, "web-especial-disponible");

  // ── Stock en cero: la regla de agotado existente lo marca y no deja agregar ──
  await ajustarStock(p.id, -12);
  await page.reload();
  await expect(page.getByText("Agotado").first()).toBeVisible();
  await expect(page.getByTestId("add-to-cart")).toHaveCount(0);
  await expect(page.getByText("Por ahora no hay piezas disponibles.")).toBeVisible();
  await capturar(page, "web-especial-agotado");

  // ── Desactivado: fuera del menú y sin página ─────────────────────────────
  await activar(p.id, false);
  await page.goto("/menu");
  await expect(page.getByRole("link", { name: nombre })).toHaveCount(0);
  const res = await page.goto(`/producto/${p.slug}`);
  expect(res?.status()).toBe(404);

  // ── Reactivado la temporada siguiente: vuelve tal cual, con su precio ────
  await activar(p.id, true);
  await ajustarStock(p.id, 6);
  await page.goto(`/producto/${p.slug}`);
  await expect(page.getByTestId("product-title")).toHaveText(nombre);
  await expect(page.getByTestId("add-to-cart")).toBeEnabled();
  await expect(page.getByText("$450", { exact: false }).first()).toBeVisible();
});
