import { expect, test } from "@playwright/test";

test.describe("club de clientes", () => {
  test("registro en /unete → tarjeta con código, QR y puntos", async ({ page }) => {
    await page.goto("/club");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Cada compra suma");
    await page.getByRole("link", { name: "Quiero mi tarjeta" }).click();
    await expect(page).toHaveURL(/\/unete$/);

    // Validación: sin teléfono ni correo
    await page.getByTestId("join-name").fill("Cliente E2E");
    await page.getByTestId("join-submit").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/teléfono/i);

    const phone = `65${String(Date.now()).slice(-8)}`;
    await page.getByTestId("join-phone").fill(phone);
    await page.getByTestId("join-submit").click();

    await expect(page).toHaveURL(/\/mi-tarjeta\/.+\?bienvenida=1/, { timeout: 20_000 });
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("card-name")).toHaveText("Cliente E2E");
    await expect(page.getByTestId("card-code")).toHaveText(/PDP-\d{6}/);
    await expect(page.getByTestId("card-qr")).toBeVisible();
    await expect(page.getByTestId("card-points")).toHaveText("0");
    await expect(page.getByRole("link", { name: "Guardar en el teléfono" })).toHaveAttribute("download", /tarjeta-PDP-\d{6}\.png/);

    // La tarjeta se puede volver a abrir sin el parámetro de bienvenida
    const url = new URL(page.url());
    await page.goto(`${url.pathname}`);
    await expect(page.getByTestId("card-name")).toHaveText("Cliente E2E");

    // Token inválido → 404
    const res = await page.request.get(`${url.origin}/mi-tarjeta/token-que-no-existe`);
    expect(res.status()).toBe(404);
  });
});
