import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Auditoría Catálogo · Clientes · Cupones · Precios (regresiones de docs/audit/catalog.md):
 *  1. Cliente con "+52 664…" reutiliza al de 10 dígitos (antes: duplicado).
 *  2. Ajuste de puntos negativo mayor al saldo → error legible; saldo intacto.
 *  3. Cupón con vigencia "hoy" es válido hoy en el probador (fechas en la zona del negocio).
 *  4. Dos pestañas editando el mismo producto: la segunda no pisa a la primera.
 *  5. Promoción solapada en el mismo canal se rechaza con aviso; terminar promo muestra confirmación.
 *  6. Exportación CSV: BOM + cabecera; rango > 366 días → 400; sin permiso → 403 (usuario marketing si existe).
 * Requiere servidor en E2E_BASE_URL y el usuario semilla. Chromium; sin `networkidle`.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";
const UUID = "[0-9a-f-]{36}";

async function fillField(page: Page, selector: string, value: string) {
  for (let i = 0; i < 5; i++) {
    await page.fill(selector, value);
    await page.waitForTimeout(250);
    if ((await page.inputValue(selector)) === value) return;
  }
  await page.fill(selector, value);
}

/** Espera a que React haya hidratado (si se envía antes, la server action recibe un FormData vacío). */
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

/** Alertas de formulario (excluye el anunciador de rutas de Next, que también es role=alert). */
const alertWith = (page: Page, text: string | RegExp) =>
  page.getByRole("alert").filter({ hasText: text });

async function login(page: Page, email = EMAIL, password = PASSWORD) {
  await open(page, "/login");
  for (let attempt = 0; attempt < 3; attempt++) {
    await fillField(page, "#email", email);
    await fillField(page, "#password", password);
    await page.getByRole("button", { name: "Entrar" }).click();
    const outcome = await Promise.race([
      page
        .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 })
        .then(() => "ok" as const),
      page
        .locator("form")
        .getByRole("alert")
        .waitFor({ timeout: 10_000 })
        .then(() => "alert" as const),
    ]).catch(() => "timeout" as const);
    if (outcome === "ok") return true;
    if (outcome === "alert") return false;
  }
  throw new Error("No se pudo iniciar sesión");
}

test.describe("Auditoría catálogo/clientes", () => {
  test.describe.configure({ mode: "serial" });
  let stamp = "";
  test.beforeAll(({}, testInfo) => {
    stamp = `${Date.now().toString().slice(-6)}${testInfo.parallelIndex % 10}`;
  });

  test("cliente: +52 no duplica; ajuste negativo insuficiente se rechaza", async ({ page }) => {
    await login(page);
    const phone10 = `664${stamp}`;
    const name = `Audit Cliente ${stamp}`;
    await open(page, "/clientes/nuevo");
    await fillField(page, "#full_name", name);
    await fillField(
      page,
      "#phone",
      `+52 ${phone10.slice(0, 3)} ${phone10.slice(3, 6)} ${phone10.slice(6)}`,
    );
    await fillField(page, "#email", `audit-${phone10}@example.com`);
    await page.getByRole("button", { name: "Registrar cliente" }).click();
    await page.waitForURL(new RegExp(`/clientes/${UUID}\\?creado=1`), { timeout: 20_000 });
    const customerUrl = new URL(page.url()).pathname;
    // Se guardó en forma canónica (10 dígitos)
    await expect(page.getByText(phone10, { exact: false }).first()).toBeVisible();

    // Segundo registro con el mismo número en 10 dígitos → mismo cliente
    await open(page, "/clientes/nuevo");
    await fillField(page, "#full_name", `${name} bis`);
    await fillField(page, "#phone", phone10);
    // Correo distinto a propósito: el dedupe por teléfono debe seguir mandando al mismo cliente.
    await fillField(page, "#email", `audit-bis-${phone10}@example.com`);
    await page.getByRole("button", { name: "Registrar cliente" }).click();
    await page.waitForURL(new RegExp(`${customerUrl}\\?existente=1`), { timeout: 20_000 });
    await expect(page.getByText("Ya existía un cliente")).toBeVisible();

    // Ajuste de puntos: +40 ok, −999 insuficiente
    await open(page, customerUrl);
    await fillField(page, "#points", "40");
    await fillField(page, "#reason", "Cortesía auditoría");
    await page.getByRole("button", { name: "Aplicar ajuste" }).click();
    await expect(page.getByRole("status")).toContainText("Nuevo saldo: 40", { timeout: 15_000 });
    await fillField(page, "#points", "-999");
    await fillField(page, "#reason", "Debe fallar");
    await page.getByRole("button", { name: "Aplicar ajuste" }).click();
    await expect(alertWith(page, "Puntos insuficientes")).toBeVisible({ timeout: 15_000 });
    await open(page, customerUrl);
    await expect(page.getByText("40", { exact: true }).first()).toBeVisible();
  });

  test("cupón vigente 'hoy' (zona del negocio) es válido en el probador", async ({ page }) => {
    await login(page);
    const code = `AUD${stamp}`;
    // Fecha local del negocio (America/Tijuana por defecto)
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.E2E_BUSINESS_TZ ?? "America/Tijuana",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    await open(page, "/cupones/nuevo");
    await fillField(page, "#cp_code", code);
    await page.selectOption("#cp_kind", "pct");
    await fillField(page, "#cp_pct", "10");
    await fillField(page, "#cp_start", today);
    await fillField(page, "#cp_end", today);
    await page.getByRole("button", { name: "Crear cupón" }).click();
    await page.waitForURL(new RegExp(`/cupones/${UUID}`), { timeout: 20_000 });
    // El formulario de edición muestra las mismas fechas (no corridas un día por UTC)
    await expect(page.locator("#cp_start")).toHaveValue(today);
    await expect(page.locator("#cp_end")).toHaveValue(today);

    await open(page, "/cupones");
    await fillField(page, "#t_code", code);
    await fillField(page, "#t_subtotal", "200");
    await page.getByRole("button", { name: "Probar" }).click();
    await expect(page.getByRole("status")).toContainText("Válido: descuento de $20.00", {
      timeout: 15_000,
    });
    // Fecha fin antes del inicio se rechaza
    await open(page, `/cupones/nuevo`);
    await fillField(page, "#cp_code", `${code}B`);
    await fillField(page, "#cp_pct", "5");
    await fillField(page, "#cp_start", today);
    await fillField(page, "#cp_end", "2020-01-01");
    await page.getByRole("button", { name: "Crear cupón" }).click();
    await expect(alertWith(page, "termina antes de empezar")).toBeVisible({ timeout: 15_000 });
  });

  test("producto: dos pestañas → la segunda no pisa la primera; promo solapada se rechaza", async ({
    page,
    context,
  }) => {
    await login(page);
    const productName = `Audit Prod ${stamp}`;
    await open(page, "/productos/nuevo");
    await page.getByLabel("Nombre").fill(productName);
    await page.getByLabel("Precio regular (MXN)").fill("50");
    await page.getByRole("button", { name: "Crear producto" }).click();
    await page.waitForURL(new RegExp(`/productos/${UUID}\\?creado=1`), { timeout: 20_000 });
    const productId = new URL(page.url()).pathname.split("/").pop()!;

    // Pestaña B abre el mismo producto antes de que A guarde
    const pageB: Page = await (context as BrowserContext).newPage();
    await open(pageB, `/productos/${productId}`);
    await open(page, `/productos/${productId}`);
    await page.getByLabel("Descripción corta").fill("Editado en A");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.getByRole("status")).toContainText("Producto guardado", { timeout: 15_000 });

    await pageB.getByLabel("Descripción corta").fill("Editado en B (viejo)");
    await pageB.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(alertWith(pageB, "Alguien más guardó")).toBeVisible({ timeout: 15_000 });
    await open(pageB, `/productos/${productId}`);
    await expect(pageB.getByLabel("Descripción corta")).toHaveValue("Editado en A");
    await pageB.close();

    // Promociones: A ok, B solapada (mismo canal) rechazada, terminar A confirma
    await open(page, `/precios/${productId}`);
    await fillField(page, "#promo-label", "Promo A");
    await fillField(page, "#promo-price", "40");
    await page.getByRole("button", { name: "Crear promoción" }).click();
    await expect(page.getByRole("status")).toContainText('Promoción "Promo A" creada', {
      timeout: 15_000,
    });
    await fillField(page, "#promo-label", "Promo B");
    await fillField(page, "#promo-price", "45");
    await page.getByRole("button", { name: "Crear promoción" }).click();
    await expect(alertWith(page, 'Ya existe la promoción "Promo A"')).toBeVisible({
      timeout: 15_000,
    });
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Terminar" }).first().click();
    await page.waitForURL(/ok=promo-terminada/, { timeout: 15_000 });
    await expect(page.getByText("Promoción terminada")).toBeVisible();
  });

  test("exportación CSV: BOM, cabecera, tope de 366 días y permiso", async ({ page, browser }) => {
    await login(page);
    const ok = await page.request.get(
      "/api/reports/export?report=diario&from=2026-09-01&to=2026-09-12",
    );
    expect(ok.status()).toBe(200);
    const body = await ok.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body.split("\n")[0]).toContain("Fecha,Ventas,Ingresos (MXN)");
    const tooLong = await page.request.get(
      "/api/reports/export?report=diario&from=2020-01-01&to=2026-09-12",
    );
    expect(tooLong.status()).toBe(400);
    const badKind = await page.request.get(
      "/api/reports/export?report=nope&from=2026-09-01&to=2026-09-02",
    );
    expect(badKind.status()).toBe(400);

    // Usuario sin reports.export (si existe en esta base): 403
    const mktCtx = await browser.newContext();
    const mkt = await mktCtx.newPage();
    const logged = await login(
      mkt,
      process.env.E2E_MARKETING_EMAIL ?? "marketing@elpandepaula.local",
      process.env.E2E_MARKETING_PASSWORD ?? "AuditClave!2026",
    ).catch(() => false);
    if (logged) {
      const denied = await mkt.request.get(
        "/api/reports/export?report=diario&from=2026-09-01&to=2026-09-12",
      );
      expect(denied.status()).toBe(403);
    } else {
      test.info().annotations.push({
        type: "skipped-part",
        description: "sin usuario marketing en esta base; permiso verificado solo por código",
      });
    }
    await mktCtx.close();
  });
});
