import { expect, test, type Page } from "@playwright/test";

/**
 * Catálogo / recetas end-to-end:
 * login → crear categoría → crear producto con precio → verlo en la lista →
 * crear ingrediente con precio → receta del producto → registrar nuevo precio del insumo → el costo de la receta cambia.
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
    // Página fresca en cada intento: sin alertas previas que confundan la espera.
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await fillField(page, "Correo", EMAIL);
    await fillField(page, "Contraseña", PASSWORD);
    // La hidratación tardía puede vaciar los campos: espera y vuelve a verificar antes de enviar.
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

test.describe.configure({ mode: "serial" });

test("catálogo: categoría → producto con precio → ingrediente → receta → nuevo precio cambia el costo", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const ts = Date.now().toString(36);
  const categoryName = `Cat E2E ${ts}`;
  const productName = `Prod E2E ${ts}`;
  const ingredientName = `Harina E2E ${ts}`;

  await login(page);

  // ── Categoría ──
  await page.goto("/categorias");
  await fillField(page, "Nombre", categoryName);
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("status")).toContainText("creada");
  await expect(page.getByRole("link", { name: categoryName })).toBeVisible();

  // ── Producto con precio regular ──
  await page.goto("/productos/nuevo");
  await fillField(page, "Nombre", productName);
  await expect(page.getByLabel("Slug (URL)")).toHaveValue(`prod-e2e-${ts}`);
  await page.getByLabel("Categoría").selectOption({ label: categoryName });
  await fillField(page, "Precio regular (MXN)", "45");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await page.waitForURL(new RegExp(`/productos/${UUID}\\?creado=1`), { timeout: 20_000 });
  const productId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByRole("heading", { name: productName })).toBeVisible();
  await expect(
    page.getByText("Precio creado", { exact: false }).or(page.getByText("Producto creado")),
  ).toBeVisible();

  // ── Lista de productos ──
  await page.goto(`/productos?q=${encodeURIComponent(productName)}`);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: productName }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("$45.00");
  await expect(row).toContainText(categoryName);
  await expect(row).toContainText("sin receta");

  // ── Ingrediente con precio inicial: $20 por 1 kg → $0.02/g ──
  await page.goto("/ingredientes/nuevo");
  await fillField(page, "Nombre", ingredientName);
  await fillField(page, "Precio (MXN)", "20");
  await fillField(page, "Contenido", "1");
  await page.getByLabel("Unidad", { exact: true }).selectOption("kg");
  await page.getByRole("button", { name: "Crear ingrediente" }).click();
  await page.waitForURL(new RegExp(`/ingredientes/${UUID}\\?creado=1`), { timeout: 20_000 });
  const ingredientId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByText("$0.02", { exact: false }).first()).toBeVisible();

  // ── Receta: 500 g de harina, rinde 10 → 10 MXN / 10 = $1.00 por pieza ──
  await page.goto(`/recetas/${productId}`);
  await page.getByLabel("Agregar ingrediente").selectOption({ label: ingredientName });
  await fillField(page, `Cantidad de ${ingredientName}`, "500");
  await fillField(page, "Rendimiento (piezas)", "10");
  await page.getByRole("button", { name: "Guardar receta" }).click();
  await expect(page.getByRole("status")).toContainText("Costo por pieza: $1.00");
  await expect(page.getByTestId("sql-cost")).toHaveText("$1.00");

  // ── Nuevo precio del insumo: $40 por 1 kg → costo por pieza sube a $2.00 ──
  await page.goto(`/ingredientes/${ingredientId}`);
  await fillField(page, "Precio pagado (MXN)", "40");
  await fillField(page, "Contenido", "1");
  await page.getByLabel("Unidad de compra").selectOption("kg");
  // Previsualización en vivo: el producto aparece con su cambio de costo antes de guardar.
  await expect(page.getByText(`Cambia el costo de 1 producto`)).toBeVisible();
  await expect(page.getByText(productName).first()).toBeVisible();
  await page.getByRole("button", { name: "Registrar precio" }).click();
  await expect(page.getByRole("status")).toContainText("Cambió el costo de 1 producto");
  await expect(page.getByText("+100.0%").first()).toBeVisible();

  // ── La receta refleja el nuevo costo (verdad SQL) y la lista de productos también ──
  await page.goto(`/recetas/${productId}`);
  await expect(page.getByTestId("sql-cost")).toHaveText("$2.00");
  await page.goto(`/productos?q=${encodeURIComponent(productName)}`);
  await expect(
    page.getByRole("row").filter({ has: page.getByRole("link", { name: productName }) }),
  ).toContainText("$2.00");
});
