import { expect, test, type Page } from "@playwright/test";

/**
 * Hoja de costos end-to-end:
 * login → producto nuevo con precio → hoja de costos → MO y rendimiento inline (crea la receta y el costo
 * por pieza cambia) → aplicar sugerido (precio POS = sugerido) → margen objetivo 70% en Configuración › Fórmulas
 * (el simulador lo anticipa) → el sugerido cambia en la hoja → se restaura el 60%.
 * Requiere: servidor en E2E_BASE_URL y usuario semilla. No depende de stock ni de catálogo previo.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const UUID = "[0-9a-f-]{36}";

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

/** Edita una celda inline: clic abre el editor (reintenta mientras hidrata), escribe y Enter guarda. */
async function editCell(page: Page, testId: string, value: string) {
  const input = page.getByTestId(`${testId}-input`);
  for (let i = 0; i < 6; i++) {
    await page.getByTestId(testId).click();
    if (await input.isVisible().catch(() => false)) break;
    await page.waitForTimeout(300);
  }
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toBeHidden({ timeout: 15_000 });
}

/** Fija el margen objetivo global en Configuración › Fórmulas. */
async function setTargetMargin(page: Page, pct: string) {
  await page.goto("/configuracion?tab=formulas");
  await fillField(page, "Margen objetivo por defecto (%)", pct);
  await page.getByRole("button", { name: "Guardar parámetros" }).click();
  await expect(page.getByRole("status")).toContainText("guardados", { timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test("hoja de costos: rendimiento inline → costo cambia → aplicar sugerido → margen objetivo 70% → sugerido cambia", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const ts = Date.now().toString(36);
  const productName = `Hoja E2E ${ts}`;

  await login(page);

  // ── Producto con precio regular $45 (sin receta todavía) ──
  await page.goto("/productos/nuevo");
  await fillField(page, "Nombre", productName);
  await fillField(page, "Precio regular (MXN)", "45");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await page.waitForURL(new RegExp(`/productos/${UUID}\\?creado=1`), { timeout: 20_000 });
  const productId = new URL(page.url()).pathname.split("/").pop()!;

  try {
    // ── Hoja de costos: la fila existe sin receta ──
    await page.goto("/recetas/hoja");
    await expect(page.getByRole("heading", { name: "Hoja de costos" })).toBeVisible();
    await fillField(page, "Buscar producto", productName);
    const row = page.getByTestId(`sheet-row-${productId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("sin receta");
    const cost = page.getByTestId(`cell-cost-${productId}`);
    await expect(cost).toHaveText("—");

    // ── MO $100 por lote (crea la receta: rendimiento 1 → costo $100.00) ──
    await editCell(page, `cell-labor-${productId}`, "100");
    await expect(cost).toHaveText("$100.00", { timeout: 15_000 });

    // ── Rendimiento 10 → costo por pieza $10.00; sugerido = 10 ÷ (1 − 60%) = $25.00 ──
    await editCell(page, `cell-yield-${productId}`, "10");
    await expect(cost).toHaveText("$10.00", { timeout: 15_000 });
    await expect(page.getByTestId(`cell-suggested-${productId}`)).toHaveText("$25.00");

    // ── Fórmulas visibles con los números sustituidos ──
    await page.getByRole("button", { name: `Ver fórmulas de ${productName}` }).click();
    await expect(row.locator("xpath=following-sibling::tr[1]")).toContainText("÷ 10 × (1 + 0%)");
    await expect(row.locator("xpath=following-sibling::tr[1]")).toContainText("$10.00 ÷ (1 − 60%)");

    // ── Aplicar sugerido → precio POS = $25.00 y margen = 60% ──
    await page.getByTestId(`apply-${productId}`).click();
    await expect(page.getByTestId(`cell-pos-${productId}`)).toHaveText("$25.00", {
      timeout: 15_000,
    });
    await expect(page.getByTestId(`cell-margin-${productId}`)).toHaveText("60%");
    await expect(page.getByTestId(`apply-${productId}`)).toBeDisabled();

    // ── Configuración › Fórmulas: el simulador anticipa el cambio y al guardar el sugerido cambia ──
    await page.goto("/configuracion?tab=formulas");
    await page.getByLabel("Producto", { exact: true }).selectOption({ label: productName });
    await fillField(page, "Margen objetivo por defecto (%)", "70");
    // 10 ÷ (1 − 70%) = 33.33 → múltiplo de $1 hacia arriba = $34.00
    await expect(page.getByTestId("sim-suggested")).toContainText("$34.00");
    await page.getByRole("button", { name: "Guardar parámetros" }).click();
    await expect(page.getByRole("status")).toContainText("guardados", { timeout: 15_000 });

    await page.goto("/recetas/hoja");
    await fillField(page, "Buscar producto", productName);
    await expect(page.getByTestId(`cell-suggested-${productId}`)).toHaveText("$34.00");
    await expect(page.getByTestId(`cell-target-${productId}`)).toContainText("70%");
    // margen 60% < objetivo 70% → resaltado ámbar
    await expect(page.getByTestId(`cell-margin-${productId}`)).toHaveClass(/st-amber/);

    // ── Override por receta: margen objetivo 50% solo para este producto → sugerido $20.00 ──
    await editCell(page, `cell-target-${productId}`, "50");
    await expect(page.getByTestId(`cell-suggested-${productId}`)).toHaveText("$20.00", {
      timeout: 15_000,
    });
    await expect(page.getByTestId(`cell-margin-${productId}`)).toHaveClass(/st-green/);
  } finally {
    // Los parámetros son globales: se restaura el 60% aunque falle el test.
    await setTargetMargin(page, "60");
  }
});
