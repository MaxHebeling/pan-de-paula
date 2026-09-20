import { expect, test } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

/**
 * Flujo de compra completo: home → menú → producto → carrito → checkout (pago al recoger) → página del pedido.
 * Requiere la base seedeada (pnpm db:seed) y el sitio corriendo en E2E_WEB_URL.
 */
test.describe("tienda", () => {
  test("home → menú → producto → carrito → checkout → pedido con folio", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Pan recién horneado");
    await expect(page.getByTestId("open-status")).toBeVisible();
    await expect(page.getByTestId("fulfillment-option").first()).toBeVisible();

    await page.getByTestId("cta-menu").click();
    await expect(page).toHaveURL(/\/menu$/);
    await expect(page.getByTestId("product-card").first()).toBeVisible();

    // Búsqueda filtra en vivo
    await page.getByTestId("menu-search").fill("croissant");
    await expect(page.getByTestId("product-card").first()).toContainText(/croissant/i);
    await page.getByTestId("menu-search").fill("");

    // Producto
    await page.getByRole("link", { name: "Croissant de mantequilla" }).first().click();
    await expect(page).toHaveURL(/\/producto\/croissant-mantequilla$/);
    await expect(page.getByTestId("product-title")).toHaveText("Croissant de mantequilla");
    await page.getByRole("button", { name: "Agregar uno" }).click(); // qty 2
    await page.getByTestId("add-to-cart").click();

    // Cajón lateral
    const drawer = page.getByTestId("cart-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Croissant de mantequilla");
    await expect(page.getByTestId("cart-count")).toHaveText("2");
    await expect(page.getByTestId("drawer-total")).toContainText("90");

    // Carrito completo
    await drawer.getByRole("link", { name: "Ver carrito" }).click();
    await expect(page).toHaveURL(/\/carrito$/);
    await expect(page.getByTestId("cart-lines")).toContainText("Croissant de mantequilla");
    await expect(page.getByTestId("cart-total")).toContainText("90");

    // Cupón inexistente → error claro; el carrito sigue funcionando
    await page.getByLabel("¿Tienes un cupón?").fill("NOEXISTE");
    await page.getByRole("button", { name: "Aplicar" }).click();
    await expect(page.locator('[role="alert"].error')).toContainText(/no existe/i);

    // Checkout
    await page.getByTestId("go-checkout").click();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByTestId("fulfillment-radio").first()).toBeChecked();
    const phone = `66${String(Date.now()).slice(-8)}`;
    await page.getByTestId("name").fill("Prueba E2E");
    await page.getByTestId("phone").fill(phone);
    await page.getByTestId("pay-cash").check();
    await expect(page.getByTestId("checkout-total")).toContainText("90");
    await page.getByTestId("place-order").click();

    // Página del pedido
    await expect(page).toHaveURL(/\/pedido\/PDP-\d{4}-\d{6}\?t=[0-9a-f]{32}/, { timeout: 20_000 });
    await expect(page.getByTestId("order-folio")).toHaveText(/PDP-\d{4}-\d{6}/);
    await expect(page.getByTestId("order-status")).toHaveText("Confirmado");
    await expect(page.getByTestId("order-total")).toContainText("90");
    await expect(page.getByTestId("payment-cash")).toBeVisible();
    await expect(page.getByTestId("order-date")).toBeVisible();
    await expect(page.getByTestId("cart-count")).toHaveCount(0); // carrito vaciado

    // Sin token válido → 404
    const url = new URL(page.url());
    const res = await page.request.get(`${url.origin}${url.pathname}?t=${"0".repeat(32)}`);
    expect(res.status()).toBe(404);
    const res2 = await page.request.get(`${url.origin}${url.pathname}`);
    expect(res2.status()).toBe(404);

    await testInfo.attach("pedido", { body: page.url(), contentType: "text/plain" });
  });

  test("producto agotado sin preventa no se puede agregar (regla de disponibilidad)", async ({
    page,
  }) => {
    // La base es compartida (el CRM crea y agota productos especiales en su propia suite), así que la
    // regla se mide contra los datos y no contra el seed: en el menú hay exactamente tantos
    // "No disponible" como productos agotados sin preventa. El menú solo lista productos con precio
    // web, así que ese es el único motivo posible (apps/web/lib/availability.ts).
    const { db, pool } = createDb({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
      max: 2,
    });
    try {
      const agotados = (
        await sql<{ n: number }>`
          select count(*)::int as n
            from products p
            left join categories c on c.id = p.category_id and c.deleted_at is null
            left join inventory_levels l on l.product_id = p.id
           where p.deleted_at is null and p.is_active and p.show_on_web and p.parent_id is null
             and (p.category_id is null or (c.id is not null and c.is_active))
             and current_price_cents(p.id, 'web') is not null
             and p.track_stock and not p.allow_preorder and coalesce(l.on_hand, 0) <= 0`.execute(db)
      ).rows[0]!.n;

      await page.goto("/menu");
      await expect(page.getByTestId("product-card").first()).toBeVisible();
      const disabled = page.getByText("No disponible");
      expect(await disabled.count()).toBe(agotados);
      // Y donde dice "No disponible" no hay manera de agregar al carrito.
      const tarjetas = page.getByTestId("product-card").filter({ hasText: "No disponible" });
      expect(await tarjetas.count()).toBe(agotados);
      for (let i = 0; i < agotados; i++)
        await expect(tarjetas.nth(i).getByRole("button", { name: /Agregar/ })).toHaveCount(0);
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
  });
});
