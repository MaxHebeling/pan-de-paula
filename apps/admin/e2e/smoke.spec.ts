import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke permanente del admin — SOLO LECTURA. No crea ni modifica datos.
 * Páginas públicas siempre; con `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` además inicia sesión y comprueba
 * que el dashboard carga (y cierra sesión al final). Uso:
 *   pnpm smoke:e2e -- <web-url> <admin-url>
 *   pnpm --filter @pdp/admin exec playwright test --grep @smoke --project=desktop
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL;
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;

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

test.describe("@smoke admin", () => {
  test("GET /api/health responde 200 con {ok:true, app:'admin'}", async ({ request }) => {
    const r = await request.get("/api/health");
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, app: "admin" });
  });

  test("GET /api/ready responde 200 con la base migrada", async ({ request }) => {
    const r = await request.get("/api/ready");
    expect(r.status(), await r.text()).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, app: "admin", db: { ok: true } });
    expect(j.db.migrations).toBeGreaterThan(0);
  });

  test("/login renderiza el formulario", async ({ page }) => {
    const r = await page.goto("/login");
    expect(r?.status()).toBe(200);
    await expect(page.getByLabel("Correo")).toBeVisible();
    await expect(page.getByLabel("Contraseña")).toBeVisible();
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  });

  test("rutas privadas redirigen a /login sin sesión", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("los crons rechazan peticiones sin secreto (401)", async ({ request }) => {
    for (const path of ["/api/cron/sessions-purge", "/api/cron/stock-alerts", "/api/cron/customer-events"]) {
      const r = await request.get(path);
      expect(r.status(), path).toBe(401);
    }
  });

  test("cabeceras de seguridad y noindex", async ({ request }) => {
    const h = (await request.get("/login")).headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-robots-tag"]).toMatch(/noindex/);
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("login con credenciales E2E y dashboard carga (solo si hay credenciales)", async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "sin E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD: solo páginas públicas");
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      await fillField(page, "Correo", EMAIL!);
      await fillField(page, "Contraseña", PASSWORD!);
      await page.getByRole("button", { name: "Entrar" }).click();
      ok = await page
        .waitForURL(/\/(dashboard|cuenta)/, { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(ok, "no se pudo iniciar sesión con las credenciales E2E").toBe(true);
    if (/\/cuenta/.test(page.url())) {
      // Usuario con must_change_password: la sesión funciona; no cambiamos la contraseña en un smoke.
      await expect(page.getByRole("heading").first()).toBeVisible();
      return;
    }
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading").first()).toBeVisible();
    // Vistas de lectura críticas para operar
    for (const path of ["/pedidos", "/productos", "/notificaciones"]) {
      const r = await page.goto(path);
      expect(r?.status(), path).toBe(200);
      await expect(page.getByRole("heading").first()).toBeVisible();
    }
  });
});
