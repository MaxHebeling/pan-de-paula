import { expect, test, type Page } from "@playwright/test";

/**
 * Auditoría 360° del sitio público (docs/audit/web.md). Corre contra E2E_WEB_URL con la base seedeada.
 * No toca la base directamente: todo pasa por la UI o por peticiones HTTP públicas.
 */

const CART_KEY = "pdp.cart.v1";
const CONCHA = "concha-vainilla";
const freshPhone = (prefix: string) => `${prefix}${String(Date.now()).slice(-8)}`;

async function readCart(page: Page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), CART_KEY);
}
async function seedCart(page: Page, value: unknown) {
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k as string, v as string),
    [CART_KEY, JSON.stringify(value)],
  );
}
async function productIdOf(page: Page, slug: string): Promise<string> {
  await page.goto(`/producto/${slug}`);
  await page.getByTestId("add-to-cart").click();
  await expect(page.getByTestId("cart-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  const cart = (await readCart(page)) as { lines: Array<{ productId: string }> };
  return cart.lines[0]!.productId;
}
const consoleWatcher = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // El navegador registra los 404 esperados como "Failed to load resource"
    if (/Failed to load resource/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
};

test.describe("club · privacidad de la tarjeta", () => {
  test("la tarjeta solo se abre con su token; teléfono, código o re-registro no la exponen", async ({
    page,
  }) => {
    const phone = freshPhone("67");
    const email = `titular-${phone}@example.com`;
    await page.goto("/unete");
    await page.getByTestId("join-name").fill("Titular Privado");
    await page.getByTestId("join-phone").fill(`+52 ${phone}`);
    await page.getByTestId("join-email").fill(email);
    await page.getByTestId("join-submit").click();
    await expect(page).toHaveURL(/\/mi-tarjeta\/.+\?bienvenida=1/, { timeout: 20_000 });
    const cardUrl = new URL(page.url());
    const code = (await page.getByTestId("card-code").textContent())!.trim();
    expect(code).toMatch(/^PDP-\d{6}$/);

    // Adivinar el teléfono o el código no abre la tarjeta
    for (const guess of [phone, `52${phone}`, code, code.toLowerCase()]) {
      const res = await page.request.get(
        `${cardUrl.origin}/mi-tarjeta/${encodeURIComponent(guess)}`,
      );
      expect(res.status(), guess).toBe(404);
      expect(await res.text()).not.toContain("Titular Privado");
    }
    // El token real sí, con o sin bienvenida
    const ok = await page.request.get(`${cardUrl.origin}${cardUrl.pathname}`);
    expect(ok.status()).toBe(200);

    // Volver a registrarse con el mismo teléfono no redirige a la tarjeta ni revela el nombre
    await page.goto("/unete");
    await page.getByTestId("join-name").fill("Otra Persona");
    await page.getByTestId("join-phone").fill(phone);
    await page.getByTestId("join-email").fill(`otra-${phone}@example.com`);
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("join-existing")).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/unete$/);
    await expect(page.locator("body")).not.toContainText("Titular Privado");
    await expect(page.locator("body")).not.toContainText(code);
  });

  test("/unete: sin correo error claro; correo inválido; teléfono inválido; token inválido → 404", async ({
    page,
  }) => {
    await page.goto("/unete");
    await page.getByTestId("join-name").fill("Sin Datos");
    await page.getByTestId("join-submit").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/correo/i);
    await page.getByTestId("join-email").fill("correo@");
    await page.getByTestId("join-submit").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/correo/i);
    // Con el correo bien pero el teléfono mal, el error se mueve al teléfono (sigue siendo opcional,
    // pero si se escribe tiene que ser válido). Se parte de un formulario limpio: tras un envío
    // fallido React re-renderiza el formulario con los valores del estado y pisaría lo que se escriba.
    await page.goto("/unete");
    await page.getByTestId("join-name").fill("Sin Datos");
    await page.getByTestId("join-email").fill(`sin-datos-${Date.now()}@example.com`);
    await page.getByTestId("join-phone").fill("12345");
    await page.getByTestId("join-submit").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/teléfono/i);
    expect((await page.request.get("/mi-tarjeta/AAAAAAAAAAAAAAAAAAAAAAAA")).status()).toBe(404);
    expect((await page.request.get("/mi-tarjeta/%2F%2F%2F")).status()).toBe(404);
  });
});

test.describe("carrito · persistencia y datos hostiles", () => {
  test("localStorage corrupto o con cantidades inválidas se sanea; 999 se recorta a 50", async ({
    page,
  }) => {
    const id = await productIdOf(page, CONCHA);
    const line = (over: Record<string, unknown>) => ({
      productId: id,
      slug: CONCHA,
      name: "Concha de vainilla",
      variantLabel: null,
      unitPriceCents: 2500,
      qty: 1,
      imageUrl: null,
      categorySlug: "pan-dulce",
      ...over,
    });
    await seedCart(page, { version: 1, lines: [line({ qty: 999 })] });
    await page.goto("/carrito");
    await expect(page.getByTestId("cart-count")).toHaveText("50");
    await expect(page.getByTestId("cart-total")).toContainText("1,250");
    await expect(page.getByRole("button", { name: "Agregar uno" })).toBeDisabled();

    await seedCart(page, {
      version: 1,
      lines: [
        line({ qty: 1.5 }),
        line({ productId: "otro", qty: -2 }),
        line({ productId: "cero", qty: 0 }),
      ],
    });
    await page.reload();
    await expect(page.getByText("Aún no hay pan aquí")).toBeVisible();
    await expect(page.getByTestId("cart-count")).toHaveCount(0);

    await seedCart(page, { version: 2, lines: [line({ qty: 2 })] });
    await page.reload();
    await expect(page.getByText("Aún no hay pan aquí")).toBeVisible();

    await page.evaluate((k) => localStorage.setItem(k, "{json roto"), CART_KEY);
    await page.reload();
    await expect(page.getByText("Aún no hay pan aquí")).toBeVisible();
  });

  test("el carrito sobrevive recargas y se sincroniza entre pestañas; quitar el último deja vacío", async ({
    context,
    page,
  }) => {
    await page.goto(`/producto/${CONCHA}`);
    await page.getByRole("button", { name: "Agregar uno" }).click();
    await page.getByTestId("add-to-cart").click();
    await expect(page.getByTestId("cart-count")).toHaveText("2");
    await page.reload();
    await expect(page.getByTestId("cart-count")).toHaveText("2");

    const other = await context.newPage();
    await other.goto("/carrito");
    await expect(other.getByTestId("cart-count")).toHaveText("2");
    // Cambio en la primera pestaña → evento storage en la segunda, sin recargar
    await page.getByTestId("cart-button").click();
    await page.getByTestId("cart-drawer").getByRole("button", { name: "Agregar uno" }).click();
    await expect(other.getByTestId("cart-count")).toHaveText("3");
    // Quitar la línea desde la segunda pestaña vacía las dos
    await other.getByRole("button", { name: /Quitar Concha/ }).click();
    await expect(other.getByText("Aún no hay pan aquí")).toBeVisible();
    await expect(page.getByTestId("cart-count")).toHaveCount(0);
    expect(await readCart(page)).toBeNull();
    await other.close();
  });
});

test.describe("checkout · validaciones, métodos e idempotencia", () => {
  test("errores de teléfono/correo, métodos según configuración y un solo pedido con doble clic y 'atrás'", async ({
    page,
  }) => {
    await page.goto(`/producto/${CONCHA}`);
    await page.getByTestId("add-to-cart").click();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();
    await page.getByTestId("drawer-checkout").click();
    await expect(page).toHaveURL(/\/checkout$/);

    // Con el seed: sin instrucciones de transferencia ni Mercado Pago → solo "pagar al recoger"
    await expect(page.getByTestId("pay-cash")).toBeChecked();
    await expect(page.getByTestId("pay-transfer")).toHaveCount(0);
    await expect(page.getByTestId("pay-mercadopago")).toHaveCount(0);
    await expect(page.getByTestId("place-order")).toHaveText("Confirmar pedido");

    await page.getByTestId("name").fill("Zoë Ñandú 李");
    await page.getByTestId("phone").fill("664987654"); // 9 dígitos
    await page.getByTestId("place-order").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/10 dígitos/);

    await page.getByTestId("phone").fill("+52 664 987 6543");
    await page.getByTestId("email").fill("correo@"); // el servidor lo rechaza
    await page.getByTestId("place-order").click();
    await expect(page.locator('[role="alert"].error')).toContainText(/correo/i, {
      timeout: 15_000,
    });
    await page.getByTestId("email").fill("");

    // Doble clic: el segundo clic cae en el botón deshabilitado
    const btn = page.getByTestId("place-order");
    await btn.click();
    await btn.click({ force: true, noWaitAfter: true }).catch(() => {});
    await expect(page).toHaveURL(/\/pedido\/PDP-\d{4}-\d{6}\?t=[0-9a-f]{32}&nuevo=1/, {
      timeout: 20_000,
    });
    const orderUrl = page.url();
    await expect(page.getByTestId("order-status")).toHaveText("Confirmado");
    await expect(page.getByTestId("order-total")).toContainText("25");
    await expect(page.getByTestId("payment-cash")).toBeVisible();
    await expect(page.getByTestId("cart-count")).toHaveCount(0);
    expect(await readCart(page)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("pdp.checkout.idem.v1"))).toBeNull();

    // "Atrás" vuelve al checkout con el carrito vacío: no hay forma de duplicar el pedido
    await page.goBack();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByText("Tu carrito está vacío")).toBeVisible();

    // Parámetros de Mercado Pago en la página del pedido
    for (const [mp, text] of [
      ["success", /confirmó tu pago/],
      ["pending", /en proceso/],
      ["failure", /no se completó/],
      ["error", /No pudimos iniciar el pago/],
    ] as const) {
      await page.goto(`${orderUrl.replace("&nuevo=1", "")}&mp=${mp}`);
      await expect(page.getByRole("status")).toContainText(text);
    }
    // Token ajeno / ausente → 404 (sin filtrar datos)
    const u = new URL(orderUrl);
    const bad = await page.request.get(`${u.origin}${u.pathname}?t=${"f".repeat(32)}`);
    expect(bad.status()).toBe(404);
    expect(await bad.text()).not.toContain("Zoë Ñandú");
    expect((await page.request.get(`${u.origin}${u.pathname}`)).status()).toBe(404);
    expect(
      (
        await page.request.get(`${u.origin}/pedido/PDP-0000-000000?t=${u.searchParams.get("t")}`)
      ).status(),
    ).toBe(404);
  });

  test("'ya soy cliente': cuenta inexistente no revela nada y el rate limit corta la enumeración", async ({
    page,
  }) => {
    await page.goto(`/producto/${CONCHA}`);
    await page.getByTestId("add-to-cart").click();
    await page.getByTestId("drawer-checkout").click();
    await page.getByLabel("Ya soy cliente del club").check();
    const input = page.getByLabel("Teléfono registrado o código PDP");
    const search = page.getByRole("button", { name: "Buscar" });
    let limited = false;
    for (let i = 0; i < 21 && !limited; i++) {
      await input.fill(`60000000${String(i).padStart(2, "0")}`);
      await search.click();
      const alert = page.locator('[role="alert"].error');
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const text = (await alert.textContent()) ?? "";
      expect(text).not.toMatch(/PDP-\d{6}/);
      if (/demasiados intentos/i.test(text)) limited = true;
      else expect(text).toMatch(/No encontramos/);
    }
    expect(limited).toBe(true);
  });
});

test.describe("catálogo · 404 y estados", () => {
  test("producto/categoría inexistentes → 404 con página propia y título; estáticos correctos", async ({
    page,
  }) => {
    for (const path of [
      "/producto/no-existe",
      "/menu/no-existe",
      "/pagina-que-no-existe",
      "/pedido/PDP-2026-000001",
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("se nos quemó");
    }
    await page.goto("/pagina-que-no-existe");
    await expect(page).toHaveTitle(/Página no encontrada/);
    for (const path of [
      "/robots.txt",
      "/sitemap.xml",
      "/manifest.webmanifest",
      "/opengraph-image",
      "/api/health",
      "/api/ready",
    ]) {
      expect((await page.request.get(path)).status(), path).toBe(200);
    }
  });
});

test.describe("SEO · metadatos, JSON-LD, sitemap y robots", () => {
  test("títulos, canónicos, noindex y datos estructurados válidos", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/El Pan de Paula/);
    const origin = new URL(page.url()).origin;
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(
      new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`),
    );
    const bakery = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((els) =>
        els.map((e) => JSON.parse(e.textContent ?? "{}")).find((d) => d["@type"] === "Bakery"),
      );
    expect(bakery).toMatchObject({ "@context": "https://schema.org", name: "El Pan de Paula" });
    expect(Array.isArray(bakery.openingHoursSpecification)).toBe(true);
    expect(bakery.openingHoursSpecification[0]).toMatchObject({
      "@type": "OpeningHoursSpecification",
    });
    expect(await page.locator("h1").count()).toBe(1);

    await page.goto("/producto/croissant-mantequilla");
    await expect(page).toHaveTitle(/Croissant de mantequilla · El Pan de Paula/);
    expect(await page.locator('meta[name="description"]').getAttribute("content")).toBeTruthy();
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(
      /\/producto\/croissant-mantequilla$/,
    );
    // Regresión: la ficha perdía todo el Open Graph (og:title, og:image) al compartirse
    expect(await page.locator('meta[property="og:image"]').count()).toBeGreaterThan(0);
    expect(await page.locator('meta[property="og:title"]').getAttribute("content")).toMatch(
      /Croissant de mantequilla/,
    );
    const product = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((els) =>
        els.map((e) => JSON.parse(e.textContent ?? "{}")).find((d) => d["@type"] === "Product"),
      );
    expect(product).toMatchObject({
      name: "Croissant de mantequilla",
      offers: {
        "@type": "Offer",
        priceCurrency: "MXN",
        price: "45.00",
        availability: "https://schema.org/InStock",
      },
    });

    for (const path of ["/carrito", "/checkout"]) {
      await page.goto(path);
      expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toMatch(
        /noindex/,
      );
    }
    const robots = await (await page.request.get("/robots.txt")).text();
    for (const d of ["/checkout", "/carrito", "/pedido/", "/mi-tarjeta/", "/api/"])
      expect(robots).toContain(`Disallow: ${d}`);
    expect(robots).toMatch(/Sitemap: .*\/sitemap\.xml/);
    const sitemap = await (await page.request.get("/sitemap.xml")).text();
    expect(sitemap).toContain("/producto/croissant-mantequilla");
    expect(sitemap).toContain("/menu/croissants");
    expect(sitemap).toContain("/club");
    for (const p of ["/carrito", "/checkout", "/pedido", "/mi-tarjeta"])
      expect(sitemap).not.toContain(p);
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "El Pan de Paula", display: "standalone" });
  });
});

test.describe("frontend · consola limpia, 320 px y teclado", () => {
  test("sin errores de consola ni respuestas 4xx/5xx en las rutas principales", async ({
    page,
  }) => {
    const errors = consoleWatcher(page);
    const badResponses: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
    });
    for (const path of [
      "/",
      "/menu",
      "/menu/croissants",
      "/producto/croissant-mantequilla",
      "/carrito",
      "/checkout",
      "/unete",
      "/club",
      "/horarios",
      "/ubicacion",
      "/nosotros",
      "/privacidad",
      "/terminos",
    ]) {
      await page.goto(path, { waitUntil: "networkidle" });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(150);
    }
    expect(errors).toEqual([]);
    expect(badResponses).toEqual([]);
  });

  test("a 320 px no hay scroll horizontal y el menú móvil funciona con teclado", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [
      "/",
      "/menu",
      "/producto/croissant-mantequilla",
      "/carrito",
      "/checkout",
      "/unete",
      "/club",
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await page.goto("/");
    const burger = page.getByRole("button", { name: "Abrir menú" });
    await burger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Cerrar menú" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator("#mobile-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#mobile-menu")).toHaveCount(0);
  });

  test("Tab por la cabecera: enlace 'saltar', logo, navegación, carrito; el cajón devuelve el foco", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "la navegación de escritorio está oculta en móvil");
    await page.goto("/", { waitUntil: "networkidle" });
    // Enter sobre un botón solo actúa cuando React ya hidrató (el foco con Tab funciona antes).
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="cart-button"]');
      return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
    });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "El Pan de Paula, inicio" })).toBeFocused();
    for (const name of ["Menú", "Club", "Horarios", "Ubicación", "Nosotros"]) {
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name }),
      ).toBeFocused();
    }
    await page.keyboard.press("Tab"); // Pedir ahora
    await page.keyboard.press("Tab");
    const cartBtn = page.getByTestId("cart-button");
    await expect(cartBtn).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("cart-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Cerrar" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(cartBtn).toBeFocused();
    // Imágenes con alt y controles con nombre accesible en el menú
    await page.goto("/menu");
    const unnamed = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll("button, a[href]")).filter(
          (el) =>
            !el.getAttribute("aria-label") &&
            !el.getAttribute("aria-labelledby") &&
            !(el.textContent ?? "").trim() &&
            el.getAttribute("aria-hidden") !== "true",
        ).length,
    );
    expect(unnamed).toBe(0);
    const imgsWithoutAlt = await page.locator("img:not([alt])").count();
    expect(imgsWithoutAlt).toBe(0);
  });
});
