import { expect, test, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

/**
 * El cliente identificado en caja debe quedar pegado a la venta PARA SIEMPRE, no solo en pantalla.
 *
 * Lo que se comprueba es la cadena entera, contra la base: cliente → pedido → venta → puntos, y de
 * vuelta: la venta aparece en su ficha y en el tablero con su nombre. Y lo contrario con la misma
 * fuerza: una venta de mostrador se queda sin cliente, y un código inexistente no inventa ninguno.
 *
 * Requiere el admin corriendo (E2E_BASE_URL) y DATABASE_URL apuntando a la MISMA base.
 */
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });
const stamp = Date.now().toString().slice(-7);

test.describe.configure({ mode: "serial" });
test.skip(() => test.info().project.name !== "desktop", "basta un proyecto");

let cliente: { id: string; code: string; qr: string; nombre: string };

test.beforeAll(async () => {
  const nombre = `Cliente Caja ${stamp}`;
  const r = await sql<{ r: { customer_id: string; public_code: string; qr_token: string } }>`
    select register_customer(${JSON.stringify({
      full_name: nombre,
      phone: `662${stamp}`,
      email: `caja-${stamp}@example.com`,
      birthday: "1990-06-15",
    })}::jsonb) as r`.execute(db);
  cliente = {
    id: r.rows[0]!.r.customer_id,
    code: r.rows[0]!.r.public_code,
    qr: r.rows[0]!.r.qr_token,
    nombre,
  };
});

test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

async function entrar(page: Page) {
  await page.context().clearCookies();
  for (let i = 0; i < 4; i++) {
    await page.goto("/login?next=/pos");
    await page.waitForLoadState("domcontentloaded");
    await page.fill("#email", EMAIL);
    await page.fill("#password", PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error("No se pudo iniciar sesión");
}

/** Agrega un producto y cobra con tarjeta (no necesita caja abierta). Devuelve el folio. */
async function cobrar(page: Page): Promise<string> {
  await page.getByLabel("Buscar producto").fill("Concha");
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: /^Agregar / })
    .first()
    .click();
  const checkout = page.getByTestId("checkout-button");
  if (!(await checkout.isVisible())) await page.getByTestId("open-cart").click();
  await checkout.click();
  // La pestaña por omisión depende de si la caja está abierta (efectivo) o no (tarjeta): se elige
  // siempre "Tarjeta", que no necesita caja y no ensucia el corte de otras pruebas.
  const tarjeta = page.getByRole("tab", { name: "Tarjeta" });
  if ((await tarjeta.count()) && (await tarjeta.getAttribute("aria-selected")) !== "true")
    await tarjeta.click();
  await page.getByRole("button", { name: /Confirmar tarjeta/ }).click();
  await expect(page.getByTestId("sale-success")).toBeVisible({ timeout: 25_000 });
  const r = await sql<{ folio: string }>`
    select o.folio from sales s join orders o on o.id = s.order_id order by s.sold_at desc limit 1`.execute(
    db,
  );
  return r.rows[0]!.folio;
}

/**
 * El rastro de auditoría que explica DESPUÉS por qué una venta quedó con cliente o sin él. Se prueba
 * porque es lo único que responde esa pregunta cuando ya nadie recuerda qué pasó en la caja: si el
 * evento deja de emitirse, no se nota en pantalla y la constancia desaparece en silencio.
 */
const eventos = (tipo: string, desde: number) =>
  sql<{ n: number }>`select count(*)::int as n from domain_events
                      where event_type = ${tipo} and id > ${desde}`
    .execute(db)
    .then((r) => r.rows[0]!.n);

const ultimoEvento = () =>
  sql<{ id: number }>`select coalesce(max(id), 0) as id from domain_events`
    .execute(db)
    .then((r) => Number(r.rows[0]!.id));

const ventaDe = (folio: string) =>
  sql<{
    sale_customer: string | null;
    order_customer: string | null;
    customer_name: string | null;
  }>`select s.customer_id::text as sale_customer, o.customer_id::text as order_customer,
            o.customer_name
       from sales s join orders o on o.id = s.order_id where o.folio = ${folio}`
    .execute(db)
    .then((r) => r.rows[0]!);

test("por código: el cliente queda en la venta, en su ficha y en el tablero", async ({ page }) => {
  test.setTimeout(180_000);
  await entrar(page);
  const marca = await ultimoEvento();
  await page.goto("/pos");

  /*
   * Se escribe el código y NADA MÁS. Antes había que pulsar Enter y ese paso invisible era la
   * trampa: el código quedaba escrito, parecía reconocido y la venta salía sin cliente.
   */
  await page.getByLabel("Buscar cliente").fill(cliente.code);
  await expect(page.getByText(cliente.nombre)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Quitar cliente" })).toBeVisible();

  const folio = await cobrar(page);

  // La cadena completa, en la base: pedido y venta con el ID REAL, no solo el nombre.
  const v = await ventaDe(folio);
  expect(v.sale_customer).toBe(cliente.id);
  expect(v.order_customer).toBe(cliente.id);
  expect(v.customer_name).toBe(cliente.nombre);

  // Puntos: la compra de mostrador suma igual que la del sitio.
  const c = await sql<{ total_orders: number; points_balance: number }>`
    select total_orders, points_balance from customers where id = ${cliente.id}`.execute(db);
  expect(c.rows[0]!.total_orders).toBeGreaterThan(0);
  expect(c.rows[0]!.points_balance).toBeGreaterThan(0);

  // Y queda constancia de ambas cosas: de que se encontró al cliente y de que la venta salió con él.
  expect(await eventos("CUSTOMER_LOOKUP_OK", marca)).toBeGreaterThan(0);
  expect(await eventos("SALE_COMPLETED_WITH_CUSTOMER", marca)).toBeGreaterThan(0);
  expect(await eventos("SALE_COMPLETED_WITHOUT_CUSTOMER", marca)).toBe(0);

  // En su ficha aparece la compra…
  await page.goto(`/clientes/${cliente.id}`);
  await expect(page.getByText(folio).first()).toBeVisible();

  // …y en el tablero, el cobro del día lleva su nombre y enlaza a su ficha.
  await page.goto("/dashboard");
  const fila = page.getByTestId("cobros-hoy").getByRole("row").filter({ hasText: folio });
  await expect(fila).toContainText(cliente.nombre);
  await fila.getByRole("link", { name: cliente.nombre }).click();
  await page.waitForURL(new RegExp(`/clientes/${cliente.id}`));
});

test("con lector de códigos: el QR del cliente lo identifica desde cualquier parte de la caja", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await entrar(page);
  await page.goto("/pos");

  /*
   * Un lector USB o Bluetooth escribe muy rápido y manda Enter. Aquí se imita esa ráfaga con el foco
   * FUERA del campo del cliente, que es justo el caso que antes se perdía: el código caía en el
   * buscador de productos y no pasaba nada.
   */
  await page.locator("body").click();
  await page.keyboard.type(cliente.qr, { delay: 10 });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("scan-aviso")).toContainText(cliente.nombre, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Quitar cliente" })).toBeVisible();

  const folio = await cobrar(page);
  expect((await ventaDe(folio)).sale_customer).toBe(cliente.id);
});

test("un código inexistente no inventa un cliente ni lo deja a medias", async ({ page }) => {
  test.setTimeout(120_000);
  const antes = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
  const marca = await ultimoEvento();
  await entrar(page);
  await page.goto("/pos");

  await page.locator("body").click();
  await page.keyboard.type("QR-QUE-NO-EXISTE-12345", { delay: 10 });
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("scan-aviso")).toContainText("No se encontró", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Quitar cliente" })).toHaveCount(0);
  const despues = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
  expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  // La búsqueda fallida también deja rastro: es la mitad que explica las ventas sin cliente.
  expect(await eventos("CUSTOMER_LOOKUP_FAILED", marca)).toBeGreaterThan(0);
});

test("cambiar de cliente antes de cobrar: solo queda el último", async ({ page }) => {
  test.setTimeout(180_000);
  const otro = await sql<{ r: { customer_id: string; public_code: string } }>`
    select register_customer(${JSON.stringify({
      full_name: `Otro Caja ${stamp}`,
      phone: `663${stamp}`,
      email: `otro-caja-${stamp}@example.com`,
      birthday: "1991-07-16",
    })}::jsonb) as r`.execute(db);
  const segundo = otro.rows[0]!.r;

  await entrar(page);
  await page.goto("/pos");
  await page.getByLabel("Buscar cliente").fill(cliente.code);
  await expect(page.getByText(cliente.nombre)).toBeVisible({ timeout: 20_000 });
  // Se quita y se pone otro: la venta debe quedar con el SEGUNDO, no con el primero.
  await page.getByRole("button", { name: "Quitar cliente" }).click();
  await page.getByLabel("Buscar cliente").fill(segundo.public_code);
  await expect(page.getByText(`Otro Caja ${stamp}`)).toBeVisible({ timeout: 20_000 });

  const folio = await cobrar(page);
  expect((await ventaDe(folio)).sale_customer).toBe(segundo.customer_id);
});

test("venta de mostrador: sin cliente, y sin inventar uno", async ({ page }) => {
  test.setTimeout(120_000);
  const marca = await ultimoEvento();
  await entrar(page);
  await page.goto("/pos");
  const folio = await cobrar(page);
  const v = await ventaDe(folio);
  expect(v.sale_customer).toBeNull();
  expect(v.order_customer).toBeNull();
  // Sin cliente también se deja constancia: "nadie lo identificó" es una respuesta, el silencio no.
  expect(await eventos("SALE_COMPLETED_WITHOUT_CUSTOMER", marca)).toBeGreaterThan(0);
  expect(await eventos("SALE_COMPLETED_WITH_CUSTOMER", marca)).toBe(0);
  // Y en el tablero se dice que no está identificado, sin inventar un "cliente general".
  await page.goto("/dashboard");
  await expect(
    page.getByTestId("cobros-hoy").getByRole("row").filter({ hasText: folio }),
  ).toContainText("Sin identificar");
});
