import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Precios sincronizados: el carrito del navegador guarda el precio del momento; si administración lo
 * cambia, al volver al carrito (o al confirmar el pedido) se revalida contra el servidor, se corrige y
 * se avisa. Las compras ya hechas conservan el precio que se pagó.
 *
 * Requiere el sitio corriendo (E2E_WEB_URL) y DATABASE_URL apuntando a la MISMA base (migrada + seed):
 *   DATABASE_URL=postgres://localhost:5432/pdp_e2e_precios E2E_WEB_URL=http://localhost:3175 \
 *     pnpm --filter @pdp/web exec playwright test e2e/precios.spec.ts
 * Cada proyecto de Playwright crea su propio producto (slug único) para no pisarse.
 */
const SHOTS = process.env.SHOTS_DIR ?? path.join("test-results", "precios");

let db: Database;
let pool: { end: () => Promise<void> };

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL para la prueba de precios");
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 2 }));
  // El límite de peticiones se acumula entre corridas (misma IP): sin esto, una corrida previa puede
  // agotar la cuota de `cart-check` y la revalidación no responde, con fallos que parecen del código.
  await sql`truncate rate_limits`.execute(db);
});
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Producto propio de la prueba, visible en web, con precio regular en el canal web. */
async function nuevoProducto(nombre: string, priceCents: number) {
  const slug = `${nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
  const r = await sql<{ id: string }>`
    insert into products(name, slug, track_stock, show_on_web, is_active, allow_preorder, sort_order)
    values (${nombre}, ${slug}, false, true, true, true, 900) returning id`.execute(db);
  const id = r.rows[0]!.id;
  await sql`select set_regular_price(${id}, 'web'::price_channel, ${priceCents}, 'alta E2E')`.execute(
    db,
  );
  return { id, slug };
}

const fijarPrecio = (id: string, cents: number) =>
  sql`select set_regular_price(${id}, 'web'::price_channel, ${cents}, 'E2E')`.execute(db);

const lineasDelPedido = (productId: string) =>
  sql<{ unit_price_cents: number; total_cents: number }>`
    select unit_price_cents, total_cents from order_items where product_id = ${productId}`.execute(
    db,
  );

async function agregarAlCarrito(page: Page, slug: string) {
  await page.goto(`/producto/${slug}`);
  await expect(page.getByTestId("product-title")).toBeVisible();
  await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("cart-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
}

/** Capturas a 390 y 1280 px para revisar el aviso en móvil y en escritorio. */
async function capturar(page: Page, nombre: string, testInfo: { project: { name: string } }) {
  const dir = path.join(SHOTS, testInfo.project.name);
  await mkdir(dir, { recursive: true });
  const original = page.viewportSize();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, `${nombre}-${width}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

test.describe("precios sincronizados", () => {
  test("el carrito avisa y se corrige cuando cambia el precio", async ({ page }, testInfo) => {
    const p = await nuevoProducto(`Croissant Dubái ${testInfo.project.name}`, 11500);
    await agregarAlCarrito(page, p.slug);

    await page.goto("/carrito");
    await expect(page.getByTestId("cart-lines")).toContainText("$115.00");

    // Administración sube el precio mientras el cliente tiene el carrito abierto.
    await fijarPrecio(p.id, 12000);

    await page.reload();
    const aviso = page.getByTestId("cart-changes");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("$115.00");
    await expect(aviso).toContainText("$120.00");
    await expect(aviso).toContainText("Actualizamos tu carrito con el precio vigente");
    await expect(page.getByTestId("cart-lines")).toContainText("$120.00");
    await expect(page.getByTestId("cart-total")).toContainText("120");
    await capturar(page, "carrito-aviso", testInfo);

    // El aviso se puede ocultar y no vuelve solo (una sola llamada por carga, sin sondeos).
    await page.getByRole("button", { name: "Ocultar aviso" }).click();
    await expect(aviso).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(aviso).toHaveCount(0);
  });

  test("al confirmar con el precio viejo: no se crea el pedido en silencio; el cliente ve el cambio y confirma", async ({
    page,
  }, testInfo) => {
    const p = await nuevoProducto(`Concha de nata ${testInfo.project.name}`, 11500);
    await agregarAlCarrito(page, p.slug);

    await page.goto("/checkout");
    await expect(page.getByTestId("checkout-total")).toContainText("115");
    const phone = `66${String(Date.now()).slice(-8)}`;
    await page.getByTestId("name").fill("Prueba Precios");
    await page.getByTestId("phone").fill(phone);
    await page.getByTestId("pay-cash").check();

    // El precio cambia justo antes de enviar.
    await fijarPrecio(p.id, 12000);
    await page.getByTestId("place-order").click();

    const aviso = page.getByTestId("checkout-cart-changes");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("$120.00");
    await expect(aviso).toContainText("vuelve a confirmar");
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByTestId("checkout-total")).toContainText("120");
    expect(await lineasDelPedido(p.id)).toMatchObject({ rows: [] }); // ningún pedido creado
    await capturar(page, "checkout-aviso", testInfo);

    // El cliente ya vio el precio nuevo: ahora sí confirma.
    await page.getByTestId("place-order").click();
    await expect(page).toHaveURL(/\/pedido\/PDP-\d{4}-\d{6}\?t=[0-9a-f]{32}/, { timeout: 20_000 });
    await expect(page.getByTestId("order-total")).toContainText("120");

    const lineas = await lineasDelPedido(p.id);
    expect(lineas.rows).toEqual([{ unit_price_cents: 12000, total_cents: 12000 }]);

    // Histórico: el precio vuelve a cambiar y la compra ya hecha conserva lo que se pagó.
    const url = page.url();
    await fijarPrecio(p.id, 15000);
    await page.goto(url);
    await expect(page.getByTestId("order-total")).toContainText("120");
    expect((await lineasDelPedido(p.id)).rows).toEqual([
      { unit_price_cents: 12000, total_cents: 12000 },
    ]);
  });

  test("producto retirado del menú: se quita del carrito con aviso", async ({ page }, testInfo) => {
    const p = await nuevoProducto(`Pan retirado ${testInfo.project.name}`, 6000);
    await agregarAlCarrito(page, p.slug);
    await page.goto("/carrito");
    await expect(page.getByTestId("cart-lines")).toContainText("$60.00");

    await sql`update products set show_on_web = false where id = ${p.id}`.execute(db);
    await page.reload();

    const aviso = page.getByTestId("cart-changes");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText("ya no está en el menú");
    await expect(page.getByTestId("cart-lines")).toHaveCount(0);
  });
});
