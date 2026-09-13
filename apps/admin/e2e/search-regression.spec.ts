import { test, expect, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

async function login(page: Page) {
  await page.goto("/login?next=/clientes");
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
  });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test.describe("regresión auditoría 360°: búsqueda global", () => {
  test("teléfono con +52 encuentra al cliente y los comodines % _ no devuelven todo", async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now().toString().slice(-7);
    const phone = `664${stamp}`;
    const name = `Busqueda Regresion ${stamp}`;
    // Alta directa por la API de POS (dedupe canónico del teléfono)
    const created = await page.request.post("/api/pos/customers", {
      data: { full_name: name, phone },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(created.ok()).toBeTruthy();

    const intl = await page.request.get(
      `/api/search?q=${encodeURIComponent(`+52 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`)}`,
    );
    expect(intl.status()).toBe(200);
    const intlBody = (await intl.json()) as {
      customers: Array<{ name?: string; full_name?: string }>;
    };
    expect(JSON.stringify(intlBody.customers)).toContain(name);

    const all = await page.request.get(`/api/search?q=${encodeURIComponent("%%")}`);
    expect(all.status()).toBe(200);
    const allBody = (await all.json()) as {
      customers: unknown[];
      orders?: unknown[];
      products?: unknown[];
    };
    expect(allBody.customers.length).toBe(0);

    const underscore = await page.request.get(`/api/search?q=${encodeURIComponent("a_")}`);
    const uBody = (await underscore.json()) as { customers: unknown[] };
    expect(uBody.customers.length).toBe(0);
  });
});
