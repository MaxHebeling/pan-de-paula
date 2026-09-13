import { test, expect, type Page } from "@playwright/test";

/**
 * Operación: producción → inventario → merma → conciliación → pedido manual con transiciones válidas.
 * Corre contra un servidor ya levantado (E2E_BASE_URL) con el seed base (16 productos).
 * Cada proyecto de Playwright usa un producto distinto para no pisarse al correr en paralelo.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const CRON_SECRET = process.env.CRON_SECRET ?? "dev-cron-secret-0123456789abcdef";

const num = (s: string | null) => Number((s ?? "0").replace(/[^0-9.-]/g, ""));

/** El primer fill puede perderse al hidratar React (sobre todo en WebKit): reintenta hasta que el valor quede. */
async function fillField(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  for (let i = 0; i < 5; i++) {
    await field.fill(value);
    await page.waitForTimeout(150);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${label}"`);
}

async function login(page: Page) {
  // Nota: loginAction rechaza el envío sin `next` (form.get devuelve null, no undefined); se entra con next explícito.
  await page.goto("/login?next=/produccion");
  await page.waitForLoadState("domcontentloaded");
  await fillField(page, "Correo", EMAIL);
  await fillField(page, "Contraseña", PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => u.pathname === "/produccion" || u.pathname === "/dashboard");
}

/** Navega esperando a que termine cualquier refresh disparado por una server action (WebKit lo reporta como navegación). */
async function go(page: Page, url: string) {
  await page.waitForLoadState("domcontentloaded");
  await page.goto(url);
}

async function reconRow(page: Page, productName: string) {
  await go(page, "/inventario?tab=conciliacion");
  const row = page.locator(`[data-testid^="recon-row-"][data-product-name="${productName}"]`);
  if ((await row.count()) === 0) return { production: 0, waste: 0 };
  return {
    production: num(await row.getByTestId("recon-production").textContent()),
    waste: num(await row.getByTestId("recon-waste").textContent()),
  };
}

test.describe.configure({ mode: "serial" });

test("producción +10 → inventario → merma 2 → conciliación → pedido manual", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const product = testInfo.project.name === "mobile" ? "Concha de chocolate" : "Concha de vainilla";
  await login(page);

  // ── Producción: +1 y deshacer ──
  await go(page, "/produccion");
  const card = page.locator(`[data-testid^="product-card-"][data-product-name="${product}"]`);
  await expect(card).toBeVisible();
  const onHand0 = num(await card.getByTestId("on-hand").textContent());
  const today0 = num(await card.getByTestId("produced-today").textContent());

  await card.getByRole("button", { name: `Registrar 1 de ${product}` }).click();
  await expect(card.getByTestId("on-hand")).toHaveText(
    new RegExp(`^${(onHand0 + 1).toLocaleString("es-MX")}$`),
  );
  const undo = page.getByTestId("undo-last");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(undo).toBeHidden();
  await expect(card.getByTestId("on-hand")).toHaveText(
    new RegExp(`^${onHand0.toLocaleString("es-MX")}$`),
  );
  await expect(card.getByTestId("produced-today")).toHaveText(
    new RegExp(`^${today0.toLocaleString("es-MX")}$`),
  );

  // Foto de la conciliación después del ciclo +1/deshacer (el deshacer queda como CORRECTION −1, la producción bruta sí cuenta)
  const before = await reconRow(page, product);

  // ── Producción +10 ──
  await go(page, "/produccion");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `Registrar 10 de ${product}` }).click();
  await expect(card.getByTestId("on-hand")).toHaveText(
    new RegExp(`^${(onHand0 + 10).toLocaleString("es-MX")}$`),
  );
  await expect(card.getByTestId("produced-today")).toHaveText(
    new RegExp(`^${(today0 + 10).toLocaleString("es-MX")}$`),
  );
  await expect(page.getByTestId("total-today")).toBeVisible();

  // ── Lotes muestra el lote (y el deshecho) ──
  await go(page, "/produccion?tab=lotes");
  await expect(page.getByRole("cell", { name: product }).first()).toBeVisible();
  await expect(page.getByText("Deshecho").first()).toBeVisible();

  // ── Inventario refleja +10 ──
  await go(page, "/inventario?tab=stock");
  const stockRow = page.locator(`[data-testid^="stock-row-"][data-product-name="${product}"]`);
  await expect(stockRow.getByTestId("stock-on-hand")).toHaveText(
    new RegExp(`^${(onHand0 + 10).toLocaleString("es-MX")}$`),
  );

  // ── Merma 2 ──
  await go(page, "/inventario?tab=mermas");
  await page.getByLabel("Producto").selectOption({ label: product });
  await fillField(page, "Cantidad", "2");
  await page.getByLabel("Motivo").selectOption("broken");
  await fillField(page, "Nota", "e2e");
  await page.getByRole("button", { name: "Registrar merma" }).click();
  await expect(page.getByText("Merma registrada: −2")).toBeVisible();
  await expect(page.getByRole("cell", { name: product }).first()).toBeVisible();

  await go(page, "/inventario?tab=stock");
  await expect(stockRow.getByTestId("stock-on-hand")).toHaveText(
    new RegExp(`^${(onHand0 + 8).toLocaleString("es-MX")}$`),
  );

  // ── Conciliación: producción +10 y merma +2 respecto al inicio ──
  const after = await reconRow(page, product);
  expect(after.production - before.production).toBe(10);
  expect(after.waste - before.waste).toBe(2);

  // ── Pedido manual ──
  await go(page, "/pedidos/nuevo");
  const pick = page.locator(`[data-testid^="pick-"][data-product-name="${product}"]`);
  await pick.getByRole("button", { name: `Agregar ${product}` }).click();
  await pick.getByRole("button", { name: `Agregar ${product}` }).click();
  await expect(pick.getByTestId("line-qty")).toHaveText("2");
  await page.getByLabel("Tipo").selectOption("pickup");
  await fillField(page, "Nombre", "Cliente E2E");
  await fillField(page, "Teléfono", "6641112233");
  await page.getByRole("button", { name: "Crear pedido" }).click();
  await page.waitForURL(/\/pedidos\/[0-9a-f-]{36}$/);
  const orderPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^PDP-\d{4}-\d{6}$/);
  await expect(page.getByText("Confirmado").first()).toBeVisible();

  // Solo transiciones válidas desde "confirmed"
  const transitions = page.getByTestId("transitions");
  await expect(transitions.getByRole("button", { name: "En producción" })).toBeVisible();
  await expect(transitions.getByRole("button", { name: "Entregado" })).toHaveCount(0);

  // Pago manual → venta → descuenta stock (2)
  await expect(page.getByTestId("balance")).toBeVisible();
  await page.getByRole("button", { name: "Registrar pago" }).click();
  // El mensaje de éxito es transitorio (el formulario desaparece al refrescar): se valida el efecto.
  await expect(page.getByTestId("balance")).toBeHidden();
  await expect(page.getByText("Pagado").first()).toBeVisible();

  await transitions.getByRole("button", { name: "En producción" }).click();
  await expect(transitions.getByRole("button", { name: "Listo para retiro" })).toBeVisible();
  await transitions.getByRole("button", { name: "Listo para retiro" }).click();
  await expect(transitions.getByRole("button", { name: "Entregado" })).toBeVisible();
  await transitions.getByRole("button", { name: "Entregado" }).click();
  // Tras entregar solo queda "Completado" como transición válida
  await expect(transitions.getByRole("button", { name: "Completado" })).toBeVisible();
  await expect(transitions.getByRole("button", { name: "Entregado" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancelar pedido" })).toHaveCount(0);
  await expect(page.getByTestId("wa-link")).toHaveAttribute("href", /wa\.me\/526641112233/);
  await page.waitForLoadState("domcontentloaded");

  await go(page, "/inventario?tab=stock");
  await expect(stockRow.getByTestId("stock-on-hand")).toHaveText(
    new RegExp(`^${(onHand0 + 6).toLocaleString("es-MX")}$`),
  );

  // ── Recibo imprimible ──
  await go(page, `${orderPath}/recibo`);
  await expect(
    page
      .getByText(/PDP-\d{4}-\d{6}/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  // ── Notificaciones + contador ──
  await go(page, "/notificaciones?estado=todas");
  await expect(page.getByRole("heading", { name: "Notificaciones" })).toBeVisible();
  const count = await page.request.get("/api/notifications/unread-count");
  expect(count.ok()).toBeTruthy();
  expect(typeof (await count.json()).unread).toBe("number");
});

test("cron de alertas de stock exige secreto y no duplica alertas abiertas", async ({
  request,
}) => {
  const denied = await request.get("/api/cron/stock-alerts");
  expect(denied.status()).toBe(401);
  const first = await request.post("/api/cron/stock-alerts", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(first.ok()).toBeTruthy();
  const a = await first.json();
  expect(a.ok).toBe(true);
  if (!a.skipped) expect(a.result).toHaveProperty("low_stock");
  const second = await request.post("/api/cron/stock-alerts", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  const b = await second.json();
  expect(b.ok).toBe(true);
  if (!b.skipped) {
    expect(b.result.low_stock).toBe(0);
    expect(b.result.out_of_stock).toBe(0);
    expect(b.result.ingredient_low).toBe(0);
  }
});

test("conteo físico: crear → capturar → revisar diferencias → descartar sin tocar stock", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Solo puede haber un conteo abierto; se prueba en un proyecto.",
  );
  const product = "Concha de vainilla";
  await login(page);
  await go(page, "/inventario?tab=stock");
  const stockRow = page.locator(`[data-testid^="stock-row-"][data-product-name="${product}"]`);
  const onHand = num(await stockRow.getByTestId("stock-on-hand").textContent());

  await go(page, "/inventario?tab=conteo");
  const create = page.getByRole("button", { name: "Crear conteo" });
  if (await create.isVisible()) {
    await create.click();
    await page.waitForURL(/paso=capturar/);
  }
  await expect(page.getByText("Paso 2 de 3")).toBeVisible();
  // El esperado se congela al crear el conteo (puede diferir del stock actual si el conteo ya estaba abierto)
  const row = page.getByRole("row", { name: new RegExp(`^${product} `) });
  const expected = num(await row.getByRole("cell").nth(1).textContent());
  const counted = page.getByLabel(`Contado de ${product}`);
  // +1 (no -1): en una base recién sembrada el esperado puede ser 0 y un contado negativo se rechaza.
  await counted.fill(String(expected + 1));
  await page.getByRole("button", { name: /Guardar y revisar/ }).click();
  await page.waitForURL(/paso=revisar/);
  await expect(page.getByText("Paso 3 de 3")).toBeVisible();
  const diffRow = page.getByRole("row", { name: new RegExp(product) }).first();
  await expect(diffRow).toBeVisible();
  await expect(diffRow.getByRole("cell", { name: /^\+?1$/ }).first()).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Descartar", exact: true }).click();
  await page.waitForURL(/descartado=1/);
  await expect(page.getByText("Conteo descartado")).toBeVisible();
  await expect(page.getByRole("button", { name: "Crear conteo" })).toBeVisible();

  await go(page, "/inventario?tab=stock");
  await expect(stockRow.getByTestId("stock-on-hand")).toHaveText(
    new RegExp(`^${onHand.toLocaleString("es-MX")}$`),
  );
});
