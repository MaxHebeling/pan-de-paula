import { test, expect, type Page } from "@playwright/test";

/**
 * Campo de teléfono con país en el CRM.
 *
 * Captura de un cliente extranjero, búsqueda por su número (con y sin "+") y enlace de WhatsApp
 * bien armado. La regla de almacenamiento (México 10 dígitos, resto E.164) vive en `@pdp/domain`
 * y su espejo SQL en la migración 0044.
 */

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

/** El primer fill puede perderse durante la hidratación de React: reintenta hasta que el valor quede. */
async function fillField(page: Page, selector: string, value: string) {
  for (let i = 0; i < 5; i++) {
    await page.fill(selector, value);
    await page.waitForTimeout(300);
    if ((await page.inputValue(selector)) === value) return;
  }
  await page.fill(selector, value);
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("form, main");
      return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function login(page: Page) {
  await open(page, "/login");
  for (let attempt = 0; attempt < 3; attempt++) {
    await fillField(page, "#email", EMAIL);
    await fillField(page, "#password", PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 });
      return;
    } catch {
      // El formulario se envió antes de hidratar (campos vacíos): reintenta.
    }
  }
  throw new Error("No se pudo iniciar sesión");
}

test.describe("CRM · teléfono con país", () => {
  test.describe.configure({ mode: "serial" });
  let national = "";
  let canonical = "";
  let name = "";
  let customerUrl = "";

  test.beforeAll(({}, testInfo) => {
    const stamp = `${String(Date.now()).slice(-5)}${testInfo.parallelIndex}`;
    national = `6195${stamp}`; // 10 dígitos nacionales de Estados Unidos
    canonical = `+1${national}`;
    name = `E2E Extranjero ${stamp}`;
  });

  test("capturar cliente con número extranjero y encontrarlo con y sin +", async ({ page }) => {
    await login(page);
    await open(page, "/clientes/nuevo");

    // Cerrado: México por defecto.
    const trigger = page.getByTestId("customer-phone-country");
    await expect(trigger).toContainText("+52");
    await expect(page.getByTestId("customer-phone-list")).toHaveCount(0);

    // Abierto: los 12 países del catálogo, con bandera y prefijo.
    await trigger.click();
    const list = page.getByTestId("customer-phone-list");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(12);
    await list.getByRole("option", { name: /Estados Unidos/ }).click();
    await expect(list).toHaveCount(0);
    await expect(trigger).toContainText("+1");

    await fillField(page, "#full_name", name);
    await page.getByTestId("customer-phone").fill(national);
    await fillField(page, "#email", `e2e-intl-${national}@example.com`);
    await fillField(page, "#birthday", "1990-05-10");
    await page.getByRole("button", { name: "Registrar cliente" }).click();
    await page.waitForURL(/\/clientes\/[0-9a-f-]{36}/, { timeout: 20_000 });
    customerUrl = new URL(page.url()).pathname;

    // Guardado en E.164: la ficha muestra el número con su prefijo.
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText(canonical, { exact: false }).first()).toBeVisible();

    // Al editar, el campo se repuebla con el país correcto y el número nacional.
    await open(page, `${customerUrl}/editar`);
    await expect(page.getByTestId("customer-phone-country")).toContainText("+1");
    await expect(page.getByTestId("customer-phone")).toHaveValue(national);

    // Búsqueda del CRM: con "+" y sin "+".
    for (const q of [canonical, national, `+1 ${national}`]) {
      await open(page, `/clientes?q=${encodeURIComponent(q)}`);
      await expect(page.getByRole("link", { name })).toBeVisible();
    }

    // Búsqueda del POS (find_customer exacto): con "+", sin "+" y con separadores.
    for (const q of [
      canonical,
      `1${national}`,
      `+1 (${national.slice(0, 3)}) ${national.slice(3)}`,
    ]) {
      const res = await page.request.get(`/api/pos/customers?q=${encodeURIComponent(q)}`);
      expect(res.ok(), q).toBe(true);
      const body = (await res.json()) as { customers: Array<{ fullName: string; phone: string }> };
      expect(
        body.customers.map((c) => c.fullName),
        q,
      ).toContain(name);
    }
  });

  test("el enlace de WhatsApp lleva el prefijo del país", async ({ page }) => {
    await login(page);
    await open(page, `${customerUrl}/cumpleanos`);
    const wa = page.locator('a[href^="https://wa.me/"]').first();
    await expect(wa).toBeVisible();
    const href = await wa.getAttribute("href");
    // Sin "+" y sin el 52 de México: el número ya trae su propio prefijo.
    expect(href).toContain(`https://wa.me/1${national}`);
    expect(href).not.toContain(`wa.me/52`);
  });

  test("longitud equivocada para el país elegido → error en español, sin guardar", async ({
    page,
  }) => {
    await login(page);
    await open(page, "/clientes/nuevo");
    await page.getByTestId("customer-phone-country").click();
    await page
      .getByTestId("customer-phone-list")
      .getByRole("option", { name: "Guatemala", exact: false })
      .click();
    await fillField(page, "#full_name", `${name} malo`);
    await page.getByTestId("customer-phone").fill("5123 456");
    await fillField(page, "#email", `e2e-malo-${national}@example.com`);
    await fillField(page, "#birthday", "1990-05-10");
    await page.getByRole("button", { name: "Registrar cliente" }).click();
    await expect(page.getByText(/Guatemala/)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/clientes\/nuevo/);
  });
});
