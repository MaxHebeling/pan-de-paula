import { expect, test } from "@playwright/test";

/**
 * Instagram oficial en el sitio público: @el.pandepaula.
 * El handle sale de `business_settings.instagram_handle` (CRM → Configuración); aquí se comprueba que el
 * sitio lo muestra tal cual y que el enlace apunta al perfil correcto (el punto del handle incluido).
 * Solo lectura: no crea nada ni toca la base.
 */
const HANDLE = "el.pandepaula";
const PERFIL = new RegExp(`^https://(www\\.)?instagram\\.com/${HANDLE.replace(".", "\\.")}/?$`);

test.describe("@smoke instagram", () => {
  test("el pie de página muestra @el.pandepaula y enlaza al perfil", async ({ page }) => {
    await page.goto("/");
    const link = page.locator('footer a[href*="instagram.com"]');
    await expect(link).toHaveCount(1);
    await expect(link).toContainText(`@${HANDLE}`);
    expect(await link.getAttribute("href")).toMatch(PERFIL);
  });

  test("la página de ubicación enlaza al mismo perfil", async ({ page }) => {
    await page.goto("/ubicacion");
    const link = page.locator('main a[href*="instagram.com"]').first();
    await expect(link).toContainText(`@${HANDLE}`);
    expect(await link.getAttribute("href")).toMatch(PERFIL);
  });

  test("los datos estructurados declaran el perfil en sameAs", async ({ page }) => {
    await page.goto("/");
    const blobs = await page.locator('script[type="application/ld+json"]').allTextContents();
    const sameAs = blobs.flatMap((b) => {
      const parsed = JSON.parse(b) as { sameAs?: string[] };
      return parsed.sameAs ?? [];
    });
    expect(sameAs.some((u) => PERFIL.test(u))).toBe(true);
  });
});
