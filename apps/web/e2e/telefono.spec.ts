import { expect, test, type Page } from "@playwright/test";

/**
 * Campo de teléfono con país en el sitio público.
 *
 * Regla de almacenamiento: México se guarda con 10 dígitos y el resto del mundo en E.164. Aquí se
 * comprueba por la UI (sin tocar la base) que el país viaja al servidor, que el número extranjero
 * queda guardado y se vuelve a encontrar, y que el formulario funciona igual sin JavaScript.
 */

const CART_KEY = "pdp.cart.v1";

/** Número estadounidense único por corrida (10 dígitos nacionales). */
const usNumber = (salt: number) => `6195${String(Date.now()).slice(-5)}${salt}`;

async function fillJoin(page: Page, phone: string, email: string) {
  await page.getByTestId("join-name").fill("Cliente Internacional");
  await page.getByTestId("join-phone").fill(phone);
  await page.getByTestId("join-email").fill(email);
}

test.describe("teléfono con selector de país · sitio", () => {
  test("/unete: elegir país, registrarse y que el número quede guardado", async ({
    page,
  }, testInfo) => {
    const phone = usNumber(testInfo.parallelIndex);
    await page.goto("/unete");

    // Cerrado: México por defecto, con bandera y prefijo.
    const trigger = page.getByTestId("join-phone-country");
    await expect(trigger).toContainText("+52");
    await expect(page.getByTestId("join-phone-list")).toHaveCount(0);

    // Abierto: la lista de países con bandera y prefijo.
    await trigger.click();
    const list = page.getByTestId("join-phone-list");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(12);
    await list.getByRole("option", { name: /Estados Unidos/ }).click();
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText("+1");
    // La ayuda del campo cambia al ejemplo del país (va en el aria-describedby del input).
    const describedBy = await page.getByTestId("join-phone").getAttribute("aria-describedby");
    await expect(page.locator(`#${describedBy}`)).toContainText("619 555 0100");

    await fillJoin(page, phone, `intl-${phone}@example.com`);
    await page.getByTestId("join-submit").click();
    await expect(page).toHaveURL(/\/mi-tarjeta\/.+\?bienvenida=1/, { timeout: 20_000 });

    // Quedó guardado: repetir el alta con el MISMO número (país elegido) lo reconoce.
    await page.goto("/unete");
    await page.getByTestId("join-phone-country").click();
    await page
      .getByTestId("join-phone-list")
      .getByRole("option", { name: /Estados Unidos/ })
      .click();
    await fillJoin(page, phone, `otro-${phone}@example.com`);
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("join-existing")).toBeVisible({ timeout: 20_000 });

    // Y se encuentra igual pegándolo en internacional con México seleccionado:
    // el selector se mueve solo al país que toca.
    await page.goto("/unete");
    await fillJoin(page, `+1${phone}`, `tres-${phone}@example.com`);
    await expect(page.getByTestId("join-phone-country")).toContainText("+1");
    await expect(page.getByTestId("join-phone")).toHaveValue(phone);
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("join-existing")).toBeVisible({ timeout: 20_000 });

    // "Ya soy cliente" en el checkout (find_customer): lo encuentra escrito SIN "+" y con él.
    await page.goto("/producto/concha-vainilla");
    await page.getByTestId("add-to-cart").click();
    await page.keyboard.press("Escape");
    await page.goto("/checkout");
    await page.getByText("Ya soy cliente del club").click();
    for (const q of [`1${phone}`, `+1 ${phone}`]) {
      await page.locator("#lookup").fill(q);
      await page.getByRole("button", { name: "Buscar" }).click();
      await expect(page.getByRole("status").filter({ hasText: "¡Hola" }), q).toBeVisible({
        timeout: 15_000,
      });
    }
  });

  test("/unete: longitud equivocada para el país elegido → error en español", async ({ page }) => {
    await page.goto("/unete");
    await page.getByTestId("join-phone-country").click();
    await page
      .getByTestId("join-phone-list")
      .getByRole("option", { name: "España", exact: false })
      .click();
    await fillJoin(page, "612 345 67", `mal-${Date.now()}@example.com`);
    await page.getByTestId("join-submit").click();
    const error = page.locator('[role="alert"].error');
    await expect(error).toContainText("España");
    await expect(error).toContainText("dígitos");
    // El país elegido sigue puesto tras el error del servidor.
    await expect(page.getByTestId("join-phone-country")).toContainText("+34");
  });

  test("checkout: el país del selector viaja al servidor", async ({ page }, testInfo) => {
    await page.goto("/menu");
    await page.goto("/producto/concha-vainilla");
    await page.getByTestId("add-to-cart").click();
    await page.keyboard.press("Escape");
    await page.goto("/checkout");
    await expect(page.getByTestId("phone")).toBeVisible();

    await page.getByTestId("phone-country").click();
    await page
      .getByTestId("phone-list")
      .getByRole("option", { name: /Estados Unidos/ })
      .click();
    await page.getByTestId("name").fill("Cliente Internacional");

    // Longitud equivocada: el pedido no se crea y el error nombra el país.
    await page.getByTestId("phone").fill("619 555 010");
    await page.getByTestId("place-order").click();
    await expect(page.locator('[role="alert"].error').first()).toContainText("Estados Unidos");
    await expect(page).toHaveURL(/\/checkout/);

    // Número válido: el pedido se crea con el teléfono internacional.
    await page.getByTestId("phone").fill(usNumber(testInfo.parallelIndex));
    await page.getByTestId("place-order").click();
    await expect(page).toHaveURL(/\/pedido\/.+/, { timeout: 30_000 });
    await expect(page.getByTestId("order-folio")).toBeVisible();
  });
});

test.describe("sin JavaScript", () => {
  // reducedMotion: sin JS el sitio usa `scroll-behavior: smooth` del CSS y, en móvil, el clic de
  // Playwright persigue el desplazamiento animado sin que el botón llegue a estar "estable".
  test.use({ javaScriptEnabled: false, reducedMotion: "reduce" });

  test("/unete manda país y número, y el servidor los combina", async ({ page }, testInfo) => {
    const phone = usNumber(testInfo.parallelIndex);
    await page.goto("/unete");
    // Sin JS el selector es un <select> nativo, y el formulario se envía igual.
    const select = page.locator('select[name="phone_country"]');
    await expect(select).toBeVisible();
    await select.selectOption("US");
    await page.locator("#full_name").fill("Cliente Sin JS");
    await page.getByTestId("join-phone").fill(phone);
    await page.locator("#email").fill(`sinjs-${phone}@example.com`);
    await page.getByTestId("join-submit").click();
    await expect(page).toHaveURL(/\/mi-tarjeta\/.+\?bienvenida=1/, { timeout: 20_000 });

    // El número quedó guardado: repetirlo lo reconoce como cuenta existente.
    await page.goto("/unete");
    await page.locator('select[name="phone_country"]').selectOption("US");
    await page.locator("#full_name").fill("Cliente Sin JS 2");
    await page.getByTestId("join-phone").fill(phone);
    await page.locator("#email").fill(`sinjs2-${phone}@example.com`);
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("join-existing")).toBeVisible({ timeout: 20_000 });
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate((k) => localStorage.removeItem(k), CART_KEY).catch(() => {});
});
