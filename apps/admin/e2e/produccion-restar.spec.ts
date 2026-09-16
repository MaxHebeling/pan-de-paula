import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Tablero de Producción: stepper [− cantidad +] y resta manual.
 * Crea su propio producto (no asume catálogo ni stock previos) y verifica sumar, restar,
 * `−` deshabilitado en cero, persistencia tras recargar, varias operaciones seguidas y
 * que un doble clic no dispare dos operaciones.
 * Requiere un servidor en E2E_BASE_URL y el usuario semilla.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const UUID = "[0-9a-f-]{36}";
const num = (s: string | null) => Number((s ?? "0").replace(/[^0-9.-]/g, ""));

/** El primer fill puede perderse mientras React hidrata: verifica el valor y reintenta. */
async function fillField(page: Page, label: string | RegExp, value: string, exact = true) {
  for (let i = 0; i < 5; i++) {
    const field = page.getByLabel(label, { exact });
    await field.fill(value);
    await page.waitForTimeout(150);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo capturar "${label}"`);
}

async function login(page: Page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await fillField(page, "Correo", EMAIL);
    await fillField(page, "Contraseña", PASSWORD);
    await page.waitForTimeout(600);
    if ((await page.getByLabel("Correo").inputValue()) !== EMAIL)
      await fillField(page, "Correo", EMAIL);
    if ((await page.getByLabel("Contraseña").inputValue()) !== PASSWORD)
      await fillField(page, "Contraseña", PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/(dashboard|cuenta)/, { timeout: 10_000 }).then(() => "ok" as const),
      page
        .locator("form")
        .getByRole("alert")
        .waitFor({ timeout: 10_000 })
        .then(() => "alert" as const),
    ]).catch(() => "timeout" as const);
    if (outcome === "ok") return;
  }
  throw new Error("No se pudo iniciar sesión");
}

/** Espera a que el número mostrado sea exactamente `n` (el valor viene del servidor, no del cliente). */
async function expectCount(cell: Locator, n: number) {
  await expect(cell).toHaveText(new RegExp(`^${n.toLocaleString("es-MX")}$`), { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

// Un solo proyecto basta: el tablero es el mismo en móvil y escritorio y las operaciones tocan la base.
test.skip(() => test.info().project.name !== "desktop", "basta un proyecto");

test("producción: sumar, restar, tope en cero y persistencia", async ({ page }) => {
  test.setTimeout(180_000);
  const ts = Date.now().toString(36);
  const productName = `Pan Resta ${ts}`;

  await login(page);

  // ── Producto propio (activo y con control de stock por defecto) ──
  await page.goto("/productos/nuevo");
  await fillField(page, "Nombre", productName);
  await fillField(page, "Precio regular (MXN)", "30");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await page.waitForURL(new RegExp(`/productos/${UUID}\\?creado=1`), { timeout: 20_000 });

  await page.goto("/produccion");
  const card = page.locator(`[data-testid^="product-card-"][data-product-name="${productName}"]`);
  await expect(card).toBeVisible();
  const today = card.getByTestId("produced-today");
  const onHand = card.getByTestId("on-hand");
  const minus = card.getByTestId("step-minus");
  const plus = card.getByTestId("step-plus");
  const base = num(await onHand.textContent());

  // ── En cero no se puede restar ──
  await expectCount(today, 0);
  await expect(minus).toBeDisabled();
  await expect(plus).toBeEnabled();

  // ── Sumar con el stepper ──
  await plus.click();
  await expectCount(today, 1);
  await expectCount(onHand, base + 1);
  await expect(minus).toBeEnabled();

  // ── Restar con el stepper ──
  await minus.click();
  await expectCount(today, 0);
  await expectCount(onHand, base);
  await expect(minus).toBeDisabled();

  // ── Varias operaciones seguidas: +10 +5 −3 ──
  await card.getByRole("button", { name: `Registrar 10 de ${productName}` }).click();
  await expectCount(today, 10);
  await card.getByRole("button", { name: `Registrar 5 de ${productName}` }).click();
  await expectCount(today, 15);
  await card.getByTestId("manual-qty").fill("3");
  await card.getByTestId("manual-sub").click();
  await expectCount(today, 12);
  await expectCount(onHand, base + 12);

  // ── Persistencia tras recargar (el número vive en la base, no en el cliente) ──
  await page.reload();
  await expect(card).toBeVisible();
  await expectCount(card.getByTestId("produced-today"), 12);
  await expectCount(card.getByTestId("on-hand"), base + 12);

  // ── No se puede restar más de lo producido hoy: el botón queda deshabilitado ──
  await card.getByTestId("manual-qty").fill("13");
  await expect(card.getByTestId("manual-sub")).toBeDisabled();
  await expect(card.getByTestId("manual-add")).toBeEnabled();
  await card.getByTestId("manual-qty").fill("12");
  await expect(card.getByTestId("manual-sub")).toBeEnabled();
});

test("doble clic no dispara dos operaciones", async ({ page }) => {
  test.setTimeout(180_000);
  const ts = Date.now().toString(36);
  const productName = `Pan Doble ${ts}`;

  await login(page);
  await page.goto("/productos/nuevo");
  await fillField(page, "Nombre", productName);
  await fillField(page, "Precio regular (MXN)", "30");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await page.waitForURL(new RegExp(`/productos/${UUID}\\?creado=1`), { timeout: 20_000 });

  await page.goto("/produccion");
  const card = page.locator(`[data-testid^="product-card-"][data-product-name="${productName}"]`);
  await expect(card).toBeVisible();
  const today = card.getByTestId("produced-today");

  // Dos clics inmediatos en "+5": el segundo cae mientras `busy` bloquea la tarjeta.
  const plus5 = card.getByRole("button", { name: `Registrar 5 de ${productName}` });
  await plus5.dblclick();
  await expectCount(today, 5);
  await page.waitForTimeout(1500);
  await expectCount(today, 5);

  // Lo mismo al restar.
  const minus = card.getByTestId("step-minus");
  await minus.dblclick();
  await expectCount(today, 4);
  await page.waitForTimeout(1500);
  await expectCount(today, 4);

  // Y queda consistente tras recargar.
  await page.reload();
  await expectCount(card.getByTestId("produced-today"), 4);
});
