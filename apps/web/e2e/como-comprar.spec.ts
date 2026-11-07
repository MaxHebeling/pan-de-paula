import { test, expect } from "@playwright/test";

/**
 * Las dos formas de comprar (pedido anticipado y venta presencial) tienen que verse en la portada y en
 * /horarios: quien no pidió durante la semana debe saber que igual puede venir el viernes.
 */
for (const ruta of ["/", "/horarios"]) {
  test(`${ruta} explica la venta presencial del viernes`, async ({ page }) => {
    await page.goto(ruta);
    const bloque = page.getByTestId("como-comprar");
    await expect(bloque).toBeVisible();
    await expect(bloque).toContainText("Todos los viernes abrimos nuestra vitrina a las 6 PM");
    await expect(bloque).toContainText("París 410, Costa Azul");
    await expect(bloque).toContainText("No es necesario hacer un pedido anticipado");
  });
}
