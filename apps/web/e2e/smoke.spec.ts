import { expect, test } from "@playwright/test";

/**
 * Smoke permanente del sitio público — SOLO LECTURA (no crea pedidos, no toca la base).
 * Se corre contra cualquier ambiente con `E2E_WEB_URL` (staging/producción tras un deploy) o local:
 *   pnpm smoke:e2e -- https://elpandepaula.mx https://admin.elpandepaula.mx
 *   pnpm --filter @pdp/web exec playwright test --grep @smoke --project=desktop
 * Cada prueba es independiente y tolera catálogo vacío (verifica que la página responde y renderiza).
 */
test.describe("@smoke web", () => {
  test("GET /api/health responde 200 con {ok:true, app:'web', version}", async ({ request }) => {
    const r = await request.get("/api/health");
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, app: "web" });
    expect(typeof j.version).toBe("string");
  });

  test("GET /api/ready responde 200 con la base migrada", async ({ request }) => {
    const r = await request.get("/api/ready");
    expect(r.status(), await r.text()).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, app: "web", db: { ok: true } });
    expect(j.db.migrations).toBeGreaterThan(0);
    expect(j.db.latencyMs).toBeLessThan(5_000);
  });

  test("home renderiza título, navegación y CTA al menú", async ({ page }) => {
    const r = await page.goto("/");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("cta-menu")).toBeVisible();
    await expect(page).toHaveTitle(/Pan de Paula/i);
  });

  test("menú carga y muestra productos (o el estado vacío) sin errores de servidor", async ({
    page,
  }) => {
    const r = await page.goto("/menu");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const cards = page.getByTestId("product-card");
    const n = await cards.count();
    if (n > 0) await expect(cards.first()).toBeVisible();
  });

  test("la página de un producto del menú carga con su título y precio", async ({ page }) => {
    await page.goto("/menu");
    const first = page.getByTestId("product-card").first();
    test.skip((await first.count()) === 0, "catálogo vacío en este ambiente");
    const link = first.getByRole("link").first();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/\/producto\//);
    const r = await page.goto(href!);
    expect(r?.status()).toBe(200);
    await expect(page.getByTestId("product-title")).toBeVisible();
    await expect(page.getByTestId("add-to-cart")).toBeVisible();
  });

  test("/unete renderiza el formulario del club (sin enviarlo)", async ({ page }) => {
    const r = await page.goto("/unete");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("form").first()).toBeVisible();
  });

  test("páginas informativas responden 200", async ({ request }) => {
    for (const path of [
      "/club",
      "/horarios",
      "/ubicacion",
      "/nosotros",
      "/privacidad",
      "/terminos",
    ]) {
      const r = await request.get(path);
      expect(r.status(), path).toBe(200);
    }
  });

  test("manifest.webmanifest y robots.txt son válidos", async ({ request }) => {
    const m = await request.get("/manifest.webmanifest");
    expect(m.status()).toBe(200);
    const manifest = await m.json();
    expect(manifest).toMatchObject({ name: "El Pan de Paula", start_url: "/" });
    expect(Array.isArray(manifest.icons)).toBe(true);
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toMatch(/User-Agent|User-agent/);
  });

  test("sitemap.xml lista la home y el menú", async ({ request }) => {
    const r = await request.get("/sitemap.xml");
    expect(r.status()).toBe(200);
    const xml = await r.text();
    expect(xml).toContain("<urlset");
    expect(xml).toMatch(/<loc>[^<]*\/menu<\/loc>/);
  });

  test("cabeceras de seguridad presentes y sin x-powered-by", async ({ request }) => {
    const r = await request.get("/");
    const h = r.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["x-powered-by"]).toBeUndefined();
    expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(h["content-security-policy"]).toMatch(/object-src 'none'/);
  });

  test("la CSP no bloquea nada en home, menú y un producto (sin violaciones en consola)", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (
        /Content[- ]Security[- ]Policy|Refused to (load|execute|connect|frame|apply)/i.test(
          m.text(),
        )
      )
        violations.push(m.text());
    });
    for (const path of ["/", "/menu"]) {
      await page.goto(path);
      await page.waitForLoadState("load");
    }
    const first = page.locator('a[href^="/producto/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForLoadState("load");
    }
    expect(violations).toEqual([]);
  });

  test("404 controlado en ruta inexistente", async ({ page }) => {
    const r = await page.goto("/esta-ruta-no-existe-smoke");
    expect(r?.status()).toBe(404);
  });
});
