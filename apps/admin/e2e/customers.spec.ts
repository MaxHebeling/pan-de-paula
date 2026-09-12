import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

/** El primer fill puede perderse durante la hidratación de React (WebKit): reintenta hasta que el valor quede. */
async function fillField(page: Page, selector: string, value: string) {
  for (let i = 0; i < 5; i++) {
    await page.fill(selector, value);
    await page.waitForTimeout(300);
    if ((await page.inputValue(selector)) === value) return;
  }
  await page.fill(selector, value);
}

/**
 * Navega y espera a que React haya hidratado el formulario principal: si se envía antes, React 19 manda
 * los campos con prefijo (_1_email) y la server action recibe un FormData vacío.
 */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
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

test.describe("Clientes, fidelización, cupones y reportes", () => {
  test.describe.configure({ mode: "serial" });
  // Identificadores únicos por proyecto (mobile/desktop corren en paralelo contra la misma base)
  let stamp = "";
  let phone = "";
  let name = "";
  let coupon = "";
  let customerUrl = "";
  test.beforeAll(({}, testInfo) => {
    stamp = `${Date.now().toString().slice(-6)}${testInfo.parallelIndex % 10}`;
    phone = `664${stamp}`;
    name = `E2E Cliente ${stamp}`;
    coupon = `E2E${stamp}`;
  });

  test("login → crear cliente → tarjeta QR → ajustar puntos", async ({ page }) => {
    await login(page);
    await open(page, "/clientes/nuevo");
    await fillField(page, "#full_name", name);
    await fillField(page, "#phone", phone);
    await page.getByRole("button", { name: "Registrar cliente" }).click();
    await page.waitForURL(/\/clientes\/[0-9a-f-]{36}/, { timeout: 20_000 });
    customerUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByText("Cliente registrado.")).toBeVisible();

    // Tarjeta QR imprimible
    await open(page, `${customerUrl}/tarjeta`);
    await expect(page.getByRole("img", { name: /Código QR del cliente PDP-\d{6}/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Imprimir tarjeta" })).toBeVisible();

    // Ajuste manual de puntos
    await open(page, customerUrl);
    await fillField(page, "#points", "25");
    await fillField(page, "#reason", "Cortesía E2E");
    await page.getByRole("button", { name: "Aplicar ajuste" }).click();
    await expect(page.getByRole("status")).toContainText("Nuevo saldo: 25", { timeout: 15_000 });
    await expect(page.getByText("Ajuste manual: Cortesía E2E")).toBeVisible();
  });

  test("crear cupón y probarlo", async ({ page }) => {
    await login(page);
    await open(page, "/cupones/nuevo");
    await fillField(page, "#cp_code", coupon);
    await fillField(page, "#cp_name", "Cupón E2E");
    await page.selectOption("#cp_kind", "pct");
    await fillField(page, "#cp_pct", "10");
    await page.getByRole("button", { name: "Crear cupón" }).click();
    await page.waitForURL(/\/cupones\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: coupon })).toBeVisible();

    await open(page, "/cupones");
    await expect(page.getByRole("link", { name: coupon })).toBeVisible();
    await fillField(page, "#t_code", coupon);
    await fillField(page, "#t_subtotal", "200");
    await page.getByRole("button", { name: "Probar" }).click();
    await expect(page.getByRole("status")).toContainText("Válido: descuento de $20.00", {
      timeout: 15_000,
    });
  });

  test("reporte diario y exportación CSV", async ({ page }) => {
    await login(page);
    await open(page, "/reportes");
    await expect(
      page.getByRole("heading", { level: 2, name: /Reporte del día|Resumen de/ }),
    ).toBeVisible();
    await expect(page.getByText("Ingresos netos")).toBeVisible();
    const csvLink = page.getByRole("link", { name: "CSV" });
    await expect(csvLink).toBeVisible();
    const href = await csvLink.getAttribute("href");
    expect(href).toContain("/api/reports/export?report=diario");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain("diario_");
    const body = await res.text();
    expect(body.split("\n")[0]).toContain("Fecha,Ventas,Ingresos (MXN)");
  });
});
