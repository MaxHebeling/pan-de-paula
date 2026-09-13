import { expect, test, type Page } from "@playwright/test";

/**
 * Sistema de movimiento (docs/WEB_MOTION.md): progresivo y accesible.
 * - Con reduced motion no se oculta nada y no hay secuencias.
 * - Sin JavaScript el hero y el contenido se ven completos.
 * - Con movimiento activo, todo lo revelable termina visible al recorrer la página.
 * - El cajón del carrito se maneja con teclado (foco atrapado, Esc cierra, foco de vuelta).
 */

const hiddenReveals = (page: Page) =>
  page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]")).filter(
        (el) => el.classList.contains("reveal-wait") || getComputedStyle(el).opacity !== "1",
      ).length,
  );

const scrollThrough = (page: Page) =>
  page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = "auto";
    for (let y = 0; y < document.body.scrollHeight; y += 300) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 40));
    }
  });

test.describe("movimiento · reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("todo el contenido del home se ve sin animaciones", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("open-status")).toBeVisible();
    expect(await hiddenReveals(page)).toBe(0);
    await expect(page.getByTestId("club-card")).toBeVisible();
    await expect(page.getByTestId("how-to-order")).toBeVisible();
    // Sin Lenis ni clases de movimiento en <html>
    await expect(page.locator("html")).not.toHaveClass(/lenis/);
  });
});

test.describe("movimiento · sin JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("el hero y las secciones se ven completos", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator("html").getAttribute("data-motion")).toBeNull();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Pan recién horneado");
    await expect(page.getByTestId("cta-menu")).toBeVisible();
    await expect(page.getByTestId("open-status")).toBeVisible();
    await expect(page.getByTestId("product-card").first()).toBeVisible();
    await expect(page.getByTestId("category-card").first()).toBeVisible();
    expect(await hiddenReveals(page)).toBe(0);
    // El hero no arranca en opacity 0 aunque el script inline no corra
    const opacity = await page
      .getByRole("heading", { level: 1 })
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe("1");
  });
});

test.describe("movimiento · activo", () => {
  test("los revelados terminan visibles al recorrer el home y el hero pinta el h1 con opacidad 1", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toBeVisible();
    expect(await h1.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await scrollThrough(page);
    await expect
      .poll(async () => hiddenReveals(page), { timeout: 10_000, message: "revelados pendientes" })
      .toBe(0);
    const inCount = await page.locator("[data-reveal].reveal-in").count();
    const total = await page.locator("[data-reveal]").count();
    expect(inCount).toBe(total);
  });

  test("el cajón del carrito se abre y cierra con teclado y atrapa el foco", async ({ page }) => {
    await page.goto("/menu");
    const add = page.getByTestId("add-compact").first();
    await add.focus();
    await page.keyboard.press("Enter");

    const drawer = page.getByTestId("cart-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(drawer.getByRole("button", { name: "Cerrar" })).toBeFocused();

    // Tab varias veces: el foco nunca sale del diálogo
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        Boolean(
          document.activeElement?.closest('[data-testid="cart-drawer"]') ||
          document.activeElement === document.body,
        ),
      );
      expect(inside).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid="cart-drawer"]')),
      ),
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(page.getByTestId("cart-count")).toHaveText("1");
  });
});
