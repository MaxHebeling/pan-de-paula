import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";
import { hashPassword } from "@pdp/auth";

/**
 * Productos especiales o temporales en Producción (/produccion?tab=especiales).
 *
 * Recorre lo que hará el dueño: crear con nombre, precio y stock; editar nombre, precio y stock;
 * vender en el POS y ver bajar el stock; cambiar el precio sin tocar la venta anterior; desactivar
 * y reactivar sin perder historial; intentar duplicar y que ofrezca reactivar; y que un usuario sin
 * `catalog.write` no pueda crear ni editar.
 *
 * Requiere el admin corriendo (E2E_BASE_URL) y DATABASE_URL apuntando a la MISMA base.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026",
};
const HORNEADOR = { email: "horneador@especiales.local", password: "Especiales!2026x" };
const SHOTS = process.env.SHOTS_DIR ?? path.join("test-results", "especiales");

const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });
const num = (s: string | null) => Number((s ?? "0").replace(/[^0-9.-]/g, ""));

test.describe.configure({ mode: "serial" });
// La lista es la misma en móvil y escritorio y cada prueba escribe en la base: basta un proyecto.
test.skip(() => test.info().project.name !== "desktop", "basta un proyecto");

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("Falta DATABASE_URL para la prueba de especiales");
  // Repetible sobre una base ya usada: los especiales de corridas anteriores se retiran (soft delete)
  // para que el buscador de duplicados no compare contra ellos. En una base recién sembrada no hay ninguno.
  await sql`update products set deleted_at = now(), is_active = false
            where is_temporary and deleted_at is null`.execute(db);
  const hash = await hashPassword(HORNEADOR.password);
  await sql`insert into staff_users(email, full_name, password_hash, role_key, is_active, must_change_password)
            values (${HORNEADOR.email}, 'Horneador E2E', ${hash}, 'production', true, false)
            on conflict (email) do update set password_hash = excluded.password_hash, role_key = 'production',
              is_active = true, must_change_password = false, failed_logins = 0, locked_until = null, deleted_at = null`.execute(
    db,
  );
});
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

async function fillField(page: Page, label: string | RegExp, value: string) {
  for (let i = 0; i < 5; i++) {
    const field = page.getByLabel(label, { exact: typeof label === "string" });
    await field.fill(value);
    await page.waitForTimeout(150);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo capturar "${String(label)}"`);
}

async function login(page: Page, user = ADMIN) {
  await page.context().clearCookies();
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto("/login?next=/produccion");
    await page.waitForLoadState("domcontentloaded");
    await fillField(page, "Correo", user.email);
    await fillField(page, "Contraseña", user.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error(`No se pudo iniciar sesión como ${user.email}`);
}

const especiales = (page: Page) => page.goto("/produccion?tab=especiales");

async function crear(page: Page, nombre: string, precio: string, stock: string) {
  await fillField(page, "Nombre", nombre);
  await fillField(page, "Precio (MXN)", precio);
  await fillField(page, "Stock inicial", stock);
  await page.getByRole("button", { name: "Crear producto especial" }).click();
}

/** Edita una celda "como hoja de cálculo": abre, escribe, Enter y espera el valor nuevo. */
async function editarCelda(page: Page, testId: string, valor: string) {
  await page.getByTestId(testId).click();
  const input = page.getByTestId(`${testId}-input`);
  await expect(input).toBeVisible();
  await input.fill(valor);
  await input.press("Enter");
  await expect(input).toBeHidden({ timeout: 15_000 });
}

const filaDe = (page: Page, nombre: string): Locator =>
  page.locator(`[data-testid^="especial-row-"][data-product-name="${nombre}"]`);

const idDeFila = async (fila: Locator) =>
  (await fila.getAttribute("data-testid"))!.replace("especial-row-", "");

/**
 * El interruptor es optimista (pinta el estado nuevo antes de que responda el servidor): para no
 * navegar en medio de la escritura, se espera a que la base lo confirme.
 */
async function esperarActivo(id: string, activo: boolean) {
  await expect
    .poll(
      async () =>
        (
          await sql<{
            is_active: boolean;
          }>`select is_active from products where id = ${id}::uuid`.execute(db)
        ).rows[0]?.is_active,
      { timeout: 15_000 },
    )
    .toBe(activo);
}

/** Capturas a 390 y 1280 px para revisar la sección en móvil y en escritorio. */
async function capturar(page: Page, nombre: string) {
  await mkdir(SHOTS, { recursive: true });
  const original = page.viewportSize();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `${nombre}-${width}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

const ts = Date.now().toString(36);
const ROSCA = `Rosca de Reyes ${ts}`;
const ROSCA_NUEVA = `Rosca de Reyes grande ${ts}`;

test("alta, edición en línea, venta en POS, desactivar y reactivar", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);

  // ── El acceso está a la vista en Producción ──────────────────────────────
  await page.goto("/produccion");
  const acceso = page.getByRole("link", { name: "+ Producto especial" });
  await expect(acceso).toBeVisible();
  await acceso.click();
  await expect(page).toHaveURL(/tab=especiales/);
  await expect(page.getByRole("heading", { name: "+ Producto especial" })).toBeVisible();

  // ── Alta: nombre, precio y stock ─────────────────────────────────────────
  await crear(page, ROSCA, "450", "12");
  await expect(page.getByText(`"${ROSCA}" creado y activo con 12 en stock.`)).toBeVisible({
    timeout: 20_000,
  });
  const fila = filaDe(page, ROSCA);
  await expect(fila).toBeVisible();
  const id = await idDeFila(fila);
  await expect(page.getByTestId(`especial-precio-${id}`)).toHaveText("$450.00");
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText("12");
  await expect(page.getByTestId(`especial-activo-${id}`)).toHaveText("Activo");
  await capturar(page, "especiales-lista");

  // El precio quedó en product_prices (historial), no escrito a mano en otro lado.
  const precios = await sql<{ price_cents: number; kind: string; channel: string; label: string }>`
    select price_cents, kind::text, channel::text, label from product_prices where product_id = ${id}::uuid`.execute(
    db,
  );
  expect(precios.rows).toEqual([
    { price_cents: 45000, kind: "regular", channel: "all", label: "Alta de producto especial" },
  ]);
  // El stock entró como movimiento INITIAL, no como un lote de producción falso.
  const movs = await sql<{ type: string; reason: string | null; qty: number }>`
    select type::text, reason, qty::float8 as qty from inventory_movements where product_id = ${id}::uuid order by id`.execute(
    db,
  );
  expect(movs.rows).toEqual([{ type: "INITIAL", reason: "initial", qty: 12 }]);

  // ── Duplicado: mismo nombre activo → no deja crear otro ──────────────────
  await crear(page, ROSCA.toUpperCase(), "500", "0");
  await expect(page.getByTestId("especial-error")).toContainText("Ya existe");
  await expect(page.getByTestId("especial-error")).toContainText("está activo");
  await expect(page.getByTestId("especial-reactivar")).toHaveCount(0);
  const cuantas = await sql<{ n: string }>`
    select count(*)::text as n from products where name ilike ${ROSCA}`.execute(db);
  expect(cuantas.rows[0]!.n).toBe("1");

  // ── Edición en línea: nombre, precio y stock ─────────────────────────────
  await especiales(page);
  await editarCelda(page, `especial-nombre-${id}`, ROSCA_NUEVA);
  await expect(filaDe(page, ROSCA_NUEVA)).toBeVisible({ timeout: 15_000 });

  await editarCelda(page, `especial-precio-${id}`, "520");
  await expect(page.getByTestId(`especial-precio-${id}`)).toHaveText("$520.00", {
    timeout: 15_000,
  });

  await editarCelda(page, `especial-stock-${id}`, "30");
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText("30", {
    timeout: 15_000,
  });
  const ajuste = await sql<{ type: string; qty: number; note: string | null }>`
    select type::text, qty::float8 as qty, note from inventory_movements
    where product_id = ${id}::uuid order by id desc limit 1`.execute(db);
  expect(ajuste.rows[0]).toEqual({
    type: "CORRECTION",
    qty: 18,
    note: "ajuste desde productos especiales",
  });

  // ── Aparece en el tablero de producción como cualquier producto ──────────
  await page.goto("/produccion");
  const tarjeta = page.locator(
    `[data-testid^="product-card-"][data-product-name="${ROSCA_NUEVA}"]`,
  );
  await expect(tarjeta).toBeVisible();
  await expect(tarjeta.getByTestId("on-hand")).toHaveText("30");

  // ── Venta en el POS: el stock baja por el camino normal ──────────────────
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    for (const d of "50000") await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByTestId("open-register").click();
    await Promise.race([
      page.getByText("Caja abierta. Ya puedes cobrar en efectivo.").waitFor(),
      page.getByRole("alert").filter({ hasText: "Ya hay una caja abierta" }).waitFor(),
    ]);
  }
  await page.goto("/pos");
  await page.getByLabel("Buscar producto").fill(ROSCA_NUEVA);
  await page.getByRole("button", { name: `Agregar ${ROSCA_NUEVA}` }).click();
  const checkout = page.getByTestId("checkout-button");
  if (!(await checkout.isVisible())) await page.getByTestId("open-cart").click();
  await expect(page.getByTestId("cart-total")).toHaveText("$520.00");
  await checkout.click();
  await page.getByRole("button", { name: "Borrar todo" }).click();
  for (const d of "60000") await page.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await expect(page.getByTestId("sale-success")).toBeVisible({ timeout: 20_000 });

  await especiales(page);
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText("29");

  // ── Sale en reportes como cualquier producto ─────────────────────────────
  await page.goto("/reportes");
  await expect(page.getByRole("cell", { name: ROSCA_NUEVA, exact: true }).first()).toBeVisible();

  // ── Cambiar el precio NO altera la venta ya hecha ────────────────────────
  await especiales(page);
  await editarCelda(page, `especial-precio-${id}`, "600");
  await expect(page.getByTestId(`especial-precio-${id}`)).toHaveText("$600.00", {
    timeout: 15_000,
  });
  const vendido = await sql<{ unit_price_cents: number }>`
    select unit_price_cents from order_items where product_id = ${id}::uuid`.execute(db);
  expect(vendido.rows).toEqual([{ unit_price_cents: 52000 }]);
  const historial = await sql<{ price_cents: number; cerrado: boolean }>`
    select price_cents, (valid_to is not null) as cerrado from product_prices
    where product_id = ${id}::uuid order by valid_from`.execute(db);
  expect(historial.rows).toEqual([
    { price_cents: 45000, cerrado: true },
    { price_cents: 52000, cerrado: true },
    { price_cents: 60000, cerrado: false },
  ]);

  // ── Desactivar: sale del tablero y del POS, conserva historial ───────────
  await page.getByTestId(`especial-activo-${id}`).click();
  await expect(page.getByTestId(`especial-activo-${id}`)).toHaveText("Inactivo", {
    timeout: 15_000,
  });
  await esperarActivo(id, false);
  await page.goto("/produccion");
  await expect(
    page.locator(`[data-testid^="product-card-"][data-product-name="${ROSCA_NUEVA}"]`),
  ).toHaveCount(0);
  const tras = await sql<{ ventas: string; movimientos: string; precios: string }>`
    select (select count(*) from order_items where product_id = ${id}::uuid)::text as ventas,
           (select count(*) from inventory_movements where product_id = ${id}::uuid)::text as movimientos,
           (select count(*) from product_prices where product_id = ${id}::uuid)::text as precios`.execute(
    db,
  );
  expect(tras.rows[0]).toEqual({ ventas: "1", movimientos: "3", precios: "3" });

  // ── Duplicado de uno desactivado: ofrece reactivar y reactiva ────────────
  await especiales(page);
  await crear(page, ROSCA_NUEVA, "600", "0");
  const error = page.getByTestId("especial-error");
  await expect(error).toContainText("desactivado");
  await capturar(page, "especiales-duplicado");
  await page.getByTestId("especial-reactivar").click();
  await expect(page.getByText("se reactivó")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(`especial-activo-${id}`)).toHaveText("Activo", { timeout: 15_000 });
  await esperarActivo(id, true);
  const total = await sql<{ n: string }>`
    select count(*)::text as n from products where name = ${ROSCA_NUEVA}`.execute(db);
  expect(total.rows[0]!.n).toBe("1"); // se reactivó el mismo, no se duplicó

  // ── Los productos permanentes siguen intactos y fuera de la lista (no regresión) ──
  const conteos = await sql<{ permanentes: string; especiales: string }>`
    select (select count(*) from products where not is_temporary and deleted_at is null)::text as permanentes,
           (select count(*) from products where is_temporary and deleted_at is null)::text as especiales`.execute(
    db,
  );
  expect(Number(conteos.rows[0]!.permanentes)).toBeGreaterThan(0);
  await especiales(page);
  await expect(page.locator('[data-testid^="especial-row-"]')).toHaveCount(
    Number(conteos.rows[0]!.especiales),
  );
  await expect(
    page.locator('[data-testid^="especial-row-"][data-product-name="Concha de vainilla"]'),
  ).toHaveCount(0);
  // Y el catálogo completo los sigue mostrando a todos.
  await page.goto("/productos?q=Concha de vainilla");
  await expect(page.getByRole("link", { name: "Concha de vainilla" }).first()).toBeVisible();
});

test("stock en cero: el producto queda agotado sin reglas nuevas", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await especiales(page);
  const nombre = `Panqué navideño ${ts}`;
  await crear(page, nombre, "180", "2");
  const fila = filaDe(page, nombre);
  await expect(fila).toBeVisible({ timeout: 20_000 });
  const id = await idDeFila(fila);

  await editarCelda(page, `especial-stock-${id}`, "0");
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText("0", { timeout: 15_000 });

  // Se creó sin preventa: agotado es agotado (misma regla de apps/web/lib/availability.ts).
  const p = await sql<{ on_hand: number; track_stock: boolean; allow_preorder: boolean }>`
    select coalesce(l.on_hand, 0)::float8 as on_hand, p.track_stock, p.allow_preorder
    from products p left join inventory_levels l on l.product_id = p.id where p.id = ${id}::uuid`.execute(
    db,
  );
  expect(p.rows[0]).toEqual({ on_hand: 0, track_stock: true, allow_preorder: false });

  // La suite del sitio público corre después contra ESTA misma base: un especial agotado y activo
  // seguiría saliendo en /menu como "No disponible". Se desactiva al terminar (la regla de agotado
  // ya quedó verificada arriba y en apps/web/e2e/productos-especiales.spec.ts).
  await page.getByTestId(`especial-activo-${id}`).click();
  await esperarActivo(id, false);
});

test("sin catalog.write no se puede crear ni editar", async ({ page }) => {
  test.setTimeout(120_000);
  // Rol "production": ve el catálogo y ajusta inventario, pero NO edita catálogo.
  await login(page, HORNEADOR);
  await especiales(page);
  await expect(page.getByRole("heading", { name: "+ Producto especial" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Crear producto especial" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "+ Producto especial" })).toHaveCount(0);

  const fila = filaDe(page, ROSCA_NUEVA);
  await expect(fila).toBeVisible();
  const id = await idDeFila(fila);
  // Nombre y precio de solo lectura; el stock sí (tiene inventory.write).
  await expect(page.getByTestId(`especial-nombre-${id}`)).toBeDisabled();
  await expect(page.getByTestId(`especial-precio-${id}`)).toBeDisabled();
  await expect(page.getByTestId(`especial-activo-${id}`)).toBeDisabled();
  await expect(page.getByTestId(`especial-stock-${id}`)).toBeEnabled();

  const antes = num(await page.getByTestId(`especial-stock-valor-${id}`).textContent());
  await editarCelda(page, `especial-stock-${id}`, String(antes + 5));
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText(String(antes + 5), {
    timeout: 15_000,
  });
});

test("nombre parecido: avisa, conserva lo capturado y deja confirmar", async ({ page }) => {
  test.setTimeout(150_000);
  await login(page);
  await especiales(page);
  const base = `Galleta navideña ${ts}`;
  const parecido = `Galleta navideña 2 ${ts}`;
  await crear(page, base, "120", "4");
  await expect(filaDe(page, base)).toBeVisible({ timeout: 20_000 });

  // Se parece, pero puede ser otro producto: avisa y NO crea todavía.
  await crear(page, parecido, "250", "3");
  const error = page.getByTestId("especial-error");
  await expect(error).toContainText("Se parece mucho");
  await expect(filaDe(page, parecido)).toHaveCount(0);
  // Lo capturado no se pierde con el aviso.
  await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue(parecido);
  await expect(page.getByLabel("Precio (MXN)", { exact: true })).toHaveValue("250");
  await expect(page.getByLabel("Stock inicial", { exact: true })).toHaveValue("3");

  // Confirmado: se crea con lo que ya estaba escrito.
  await page.getByTestId("especial-crear-igual").click();
  await expect(page.getByText(`"${parecido}" creado y activo con 3 en stock.`)).toBeVisible({
    timeout: 20_000,
  });
  const fila = filaDe(page, parecido);
  await expect(fila).toBeVisible();
  const id = await idDeFila(fila);
  await expect(page.getByTestId(`especial-precio-${id}`)).toHaveText("$250.00");
  await expect(page.getByTestId(`especial-stock-valor-${id}`)).toHaveText("3");
});
