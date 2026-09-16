import { test, expect, type Page } from "@playwright/test";

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
      // El formulario se envió antes de hidratar: reintenta.
    }
  }
  throw new Error("No se pudo iniciar sesión");
}

/** Alta de cliente desde el CRM; devuelve la ruta /clientes/<uuid>. */
async function createCustomer(
  page: Page,
  data: { name: string; phone: string; birthday?: string },
): Promise<string> {
  await open(page, "/clientes/nuevo");
  await fillField(page, "#full_name", data.name);
  await fillField(page, "#phone", data.phone);
  if (data.birthday) await fillField(page, "#birthday", data.birthday);
  await page.getByRole("button", { name: "Registrar cliente" }).click();
  await page.waitForURL(/\/clientes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  return new URL(page.url()).pathname;
}

/** Fecha de hoy en la zona del negocio, en formato YYYY-MM-DD para el input date. */
function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.BUSINESS_TZ ?? "America/Tijuana",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

test.describe("Cumpleaños: detección, saludo y registro", () => {
  test.describe.configure({ mode: "serial" });
  let stamp = "";
  let name = "";
  let sinFechaName = "";
  let customerUrl = "";
  let preparedAt = "";
  const hoy = todayLocal();

  test.beforeAll(({}, testInfo) => {
    stamp = `${Date.now().toString().slice(-6)}${testInfo.parallelIndex % 10}`;
    name = `Cumpleañera ${stamp}`;
    sinFechaName = `SinFecha ${stamp}`;
  });

  test("alta con fecha de nacimiento: persiste y aparece en Cumpleaños de hoy", async ({
    page,
  }) => {
    await login(page);
    // Cumpleaños hoy (mismo día y mes, 30 años atrás)
    const birthday = `${Number(hoy.slice(0, 4)) - 30}${hoy.slice(4)}`;
    customerUrl = await createCustomer(page, {
      name,
      phone: `664${stamp}`,
      birthday,
    });
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    // La fecha de nacimiento se guardó (ficha del cliente) y aparece el acceso al saludo
    await expect(page.getByRole("link", { name: /Saludo de cumpleaños/ })).toBeVisible();

    // Edición: la fecha persiste en el formulario
    await open(page, `${customerUrl}/editar`);
    expect(await page.inputValue("#birthday")).toBe(birthday);

    // Sección del CRM
    await open(page, "/fidelizacion");
    const fila = page.locator("li", { hasText: name }).first();
    await expect(fila).toBeVisible();
    await expect(fila.getByText("Pendiente")).toBeVisible();
    await expect(fila.getByRole("link", { name: "Ver saludo" })).toBeVisible();
  });

  test("preparar el saludo es idempotente", async ({ page }) => {
    await login(page);
    await open(page, `${customerUrl}/cumpleanos`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Saludo de cumpleaños" }),
    ).toBeVisible();

    // Tarjeta premium con el texto del saludo
    const tarjeta = page.getByLabel(`Tarjeta de cumpleaños de ${name}`);
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta).toContainText("¡Feliz cumpleaños");
    await expect(tarjeta).toContainText("Hoy queremos celebrar contigo");
    await expect(tarjeta).toContainText("Con cariño");
    await expect(page.getByRole("link", { name: "Abrir WhatsApp con el mensaje" })).toHaveAttribute(
      "href",
      /^https:\/\/wa\.me\/52664\d+\?text=/,
    );

    await page.getByRole("button", { name: "Preparar saludo" }).click();
    // La acción revalida la página: el formulario desaparece y queda el sello de generación.
    await expect(page.getByText(/^Preparado el /)).toBeVisible({ timeout: 15_000 });

    // Una sola fila: ya no se ofrece volver a generarlo y el sello de generación aparece una vez
    await open(page, `${customerUrl}/cumpleanos`);
    await expect(page.getByRole("button", { name: "Preparar saludo" })).toHaveCount(0);
    await expect(page.getByText(/^Preparado el /)).toHaveCount(1);
    preparedAt = (await page.getByText(/^Preparado el /).innerText()).trim();

    await open(page, "/fidelizacion");
    const fila = page.locator("li", { hasText: name }).first();
    await expect(fila.getByText("Preparado")).toBeVisible();
  });

  test("marcarlo como enviado lo registra una sola vez", async ({ page }) => {
    await login(page);
    await open(page, `${customerUrl}/cumpleanos`);
    await page.getByRole("button", { name: "Marcar como enviado por WhatsApp" }).click();
    await expect(page.getByText(/^Enviado el /)).toBeVisible({ timeout: 15_000 });

    // Al recargar sigue enviado y ya no se ofrece ninguna acción de envío (no hay segundo saludo)
    await open(page, `${customerUrl}/cumpleanos`);
    await expect(page.getByText(/^Enviado el /)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Marcar como/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preparar saludo" })).toHaveCount(0);
    // El texto se generó una sola vez: el sello de generación no cambió
    expect((await page.getByText(/^Preparado el /).innerText()).trim()).toBe(preparedAt);

    // En el tablero el estado cambió a Enviado y desaparece la acción de envío
    await open(page, "/fidelizacion");
    const fila = page.locator("li", { hasText: name }).first();
    await expect(fila.getByText("Enviado")).toBeVisible();
    await expect(fila.getByRole("button", { name: "Marcar enviado" })).toHaveCount(0);
  });

  test("un cliente sin fecha de nacimiento no aparece ni tiene saludo", async ({ page }) => {
    await login(page);
    const url = await createCustomer(page, { name: sinFechaName, phone: `665${stamp}` });
    await expect(page.getByRole("link", { name: /Saludo de cumpleaños/ })).toHaveCount(0);

    await open(page, "/fidelizacion");
    await expect(page.getByText(sinFechaName)).toHaveCount(0);

    // La ruta directa explica qué falta en vez de mostrar una tarjeta vacía
    await open(page, `${url}/cumpleanos`);
    await expect(page.getByText("Este cliente no tiene fecha de nacimiento")).toBeVisible();
  });
});
