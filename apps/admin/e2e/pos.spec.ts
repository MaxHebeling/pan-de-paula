import { expect, test, type Page } from "@playwright/test";

/**
 * Flujo completo del POS: login → abrir caja → vender 2 productos en efectivo con cambio →
 * éxito con folio → cerrar caja con diferencia 0.
 * Requiere: servidor en E2E_BASE_URL, usuario semilla y catálogo semilla (croissant + galleta con precio POS).
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const OPENING_CASH = 50000; // $500.00

/** El primer fill puede perderse mientras React hidrata: verifica el valor y reintenta. */
async function fillField(page: Page, label: string, value: string) {
  for (let i = 0; i < 5; i++) {
    const field = page.getByLabel(label);
    await field.fill(value);
    await page.waitForTimeout(150);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo capturar "${label}"`);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  // La hidratación puede vaciar los campos justo antes del envío: reintenta el ciclo completo.
  for (let attempt = 0; attempt < 4; attempt++) {
    await fillField(page, "Correo", EMAIL);
    await fillField(page, "Contraseña", PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/(dashboard|cuenta)/, { timeout: 8000 }).then(() => "ok" as const),
      page
        .locator("form")
        .getByRole("alert")
        .filter({ hasText: /correo|contraseña|incorrectos/i })
        .waitFor({ timeout: 8000 })
        .then(() => "alert" as const),
    ]).catch(() => "timeout" as const);
    if (outcome === "ok") return;
    await page.waitForTimeout(300);
  }
  throw new Error("No se pudo iniciar sesión");
}

async function typeOnNumpad(page: Page, cents: number) {
  for (const d of String(cents)) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
}

/** Si otra sesión dejó la caja abierta, la cierra con el efectivo esperado para partir de cero. */
async function ensureRegisterClosed(page: Page) {
  await page.goto("/caja");
  const closeForm = page.getByTestId("register-close-form");
  if (await closeForm.isVisible()) {
    const expected = Number(await page.getByTestId("expected-cash").getAttribute("data-cents"));
    await page.getByRole("button", { name: "Borrar todo" }).click();
    if (expected > 0) await typeOnNumpad(page, expected);
    else await page.getByRole("button", { name: /Usar el esperado/ }).click();
    await page.getByLabel(/Confirmo el conteo/).check();
    await page.getByTestId("close-register").click();
    await page.waitForURL(/\/caja\/[0-9a-f-]+/);
  }
}

test.describe.configure({ mode: "serial" });

test("venta en efectivo de punta a punta con caja", async ({ page }) => {
  await login(page);
  await ensureRegisterClosed(page);

  // ── Abrir caja con fondo de $500 ─────────────────────────────────────────
  // La base puede ser compartida (otro worker/agente pudo abrirla en medio): si ya está abierta, seguimos con ella.
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await typeOnNumpad(page, OPENING_CASH);
    await expect(page.getByTestId("opening-cash")).toHaveText("$500.00");
    await page.getByTestId("open-register").click();
    await Promise.race([
      page.getByText("Caja abierta. Ya puedes cobrar en efectivo.").waitFor(),
      page.getByRole("alert").filter({ hasText: "Ya hay una caja abierta" }).waitFor(),
    ]);
    await page.goto("/caja");
  }
  await expect(page.getByTestId("register-close-form")).toBeVisible();
  const expectedBefore = Number(await page.getByTestId("expected-cash").getAttribute("data-cents"));

  // ── POS: agregar 2 productos ─────────────────────────────────────────────
  await page.goto("/pos");
  await expect(page.getByRole("heading", { name: "Punto de venta" })).toBeVisible();
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await page.getByRole("button", { name: "Agregar Croissant de mantequilla" }).click();
  await page.getByRole("button", { name: "Agregar Galleta de chispas de chocolate" }).click();

  // En móvil el carrito es un cajón
  const checkout = page.getByTestId("checkout-button");
  if (!(await checkout.isVisible())) await page.getByTestId("open-cart").click();
  await expect(page.getByTestId("cart-line")).toHaveCount(2);
  const totalText = (await page.getByTestId("cart-total").innerText()).trim();
  const totalCents = Math.round(Number(totalText.replace(/[^0-9.]/g, "")) * 100);
  expect(totalCents).toBeGreaterThan(0);

  // ── Cobrar en efectivo con cambio ────────────────────────────────────────
  await checkout.click();
  await expect(page.getByTestId("checkout-modal")).toBeVisible();
  await expect(page.getByTestId("checkout-total")).toHaveText(totalText);
  const tendered = Math.ceil(totalCents / 10000) * 10000 + 10000; // siguiente billete de $100 por encima
  await page.getByRole("button", { name: "Borrar todo" }).click();
  await typeOnNumpad(page, tendered);
  const expectedChange = tendered - totalCents;
  const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await expect(page.getByTestId("change")).toHaveText(fmt(expectedChange));
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();

  // ── Éxito con folio y cambio ─────────────────────────────────────────────
  await expect(page.getByTestId("sale-success")).toBeVisible();
  await expect(page.getByTestId("sale-folio")).toHaveText(/^PDP-\d{4}-\d{6}$/);
  await expect(page.getByTestId("sale-change")).toHaveText(fmt(expectedChange));
  await page.getByTestId("new-sale").click();
  await expect(page.getByTestId("sale-success")).toHaveCount(0);

  // ── Cerrar caja con diferencia 0 ─────────────────────────────────────────
  await page.goto("/caja");
  await expect(page.getByTestId("register-close-form")).toBeVisible();
  const expected = Number(await page.getByTestId("expected-cash").getAttribute("data-cents"));
  expect(expected).toBe(expectedBefore + totalCents);
  await typeOnNumpad(page, expected);
  await expect(page.getByTestId("difference")).toHaveText("$0.00");
  await page.getByLabel(/Confirmo el conteo/).check();
  await page.getByTestId("close-register").click();
  await page.waitForURL(/\/caja\/[0-9a-f-]+\?cerrada=1/);
  await expect(page.getByText("Sin diferencia: el efectivo cuadró.")).toBeVisible();
  await expect(page.getByTestId("summary-difference")).toHaveText("$0.00");
});
