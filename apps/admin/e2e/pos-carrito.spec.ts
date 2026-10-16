import { test, expect, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";
import { hashPassword } from "@pdp/auth";

/**
 * Huecos del recorrido Pedidos → Punto de Venta, detectados al analizarlo:
 *
 *  RF-001 · el carrito en curso del POS se destruía al salir a cobrar un pedido;
 *  RF-002 · desde el POS no había acceso a la cola de pendientes;
 *  RF-003 · abrir la caja desde el panel de cobro abandonaba el pedido.
 *
 * Y los que salieron de revisar críticamente ese mismo arreglo, porque guardar el carrito abrió
 * fallos peores que el que cerraba —cobrar la venta de otra persona es dinero, perder el carrito
 * solo era tiempo—:
 *
 *  RF-004 · el carrito guardado se le ofrecía al SIGUIENTE cajero de la misma tablet;
 *  RF-005 · dos pestañas del POS compartían un respaldo y la última borraba el de la otra;
 *  RF-006 · llegar a abrir la caja y encontrarla ya abierta dejaba al operador sin vuelta.
 *
 * Todos son pérdida o confusión del trabajo del cajero, así que se prueban en navegador: es donde
 * ocurren. Ninguno se puede demostrar con pruebas unitarias.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026",
};
/** Segunda persona del mostrador: el relevo de turno de RF-004. */
const CAJERA = { email: "cajera.carrito@e2e.local", password: "Carrito!2026x" };
type Usuario = { email: string; password: string };

let db: Database;
let pool: { end: () => Promise<void> };

test.beforeAll(() => {
  const d = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
  db = d.db;
  pool = d.pool;
});
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** El primer `.fill()` se pierde al hidratar React, así que se reintenta. */
async function fillField(page: Page, label: string, value: string) {
  const f = page.getByLabel(label, { exact: true });
  for (let i = 0; i < 5; i++) {
    await f.fill(value);
    await page.waitForTimeout(120);
    if ((await f.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${label}"`);
}

async function login(page: Page, next = "/dashboard", quien: Usuario = ADMIN) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("domcontentloaded");
  for (let i = 0; i < 4; i++) {
    await fillField(page, "Correo", quien.email);
    await fillField(page, "Contraseña", quien.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error("No se pudo iniciar sesión");
}

async function tecleaNumpad(page: Page, cents: number) {
  await page.getByRole("button", { name: "Borrar todo" }).first().click();
  for (const d of String(cents)) await page.getByRole("button", { name: d, exact: true }).click();
}

async function abrirCajaSiHaceFalta(page: Page) {
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await tecleaNumpad(page, 50000);
    await page.getByTestId("open-register").click();
    await page.waitForURL(/\/caja\?abierta=1/);
  }
}

/** Deja la caja cerrada, sea cual sea su estado al empezar. */
async function cerrarCajaSiEstaAbierta(page: Page) {
  await page.goto("/caja");
  if (await page.getByTestId("register-close-form").isVisible()) {
    // El cierre exige conteo: "Usar el esperado" lo rellena y hay que confirmarlo (como audit-ops).
    await page.getByRole("button", { name: /Usar el esperado/ }).click();
    await page.getByLabel(/Confirmo el conteo/).check();
    await page.getByTestId("close-register").click();
    await page.waitForURL(/\/caja\/[0-9a-f-]+/, { timeout: 20_000 });
  }
}

/** El POS no tiene "product-card" (eso es del sitio): se añade buscando y pulsando "Agregar X". */
async function agregarAlCarrito(page: Page, nombre: string) {
  await page.getByLabel("Buscar producto").fill(nombre);
  await page.getByRole("button", { name: `Agregar ${nombre}`, exact: true }).click();
  await page.getByLabel("Buscar producto").fill("");
}

async function primerProducto(): Promise<string> {
  const r = await sql<{ name: string }>`
    select name from catalog_products where is_active and show_on_pos
     order by sort_order, name limit 1`.execute(db);
  return r.rows[0]!.name;
}

/** Dos productos DISTINTOS: RF-005 necesita distinguir el carrito de cada pestaña por su contenido. */
async function dosProductos(): Promise<[string, string]> {
  const r = await sql<{ name: string }>`
    select name from catalog_products where is_active and show_on_pos
     order by sort_order, name limit 2`.execute(db);
  if (r.rows.length < 2) throw new Error("El catálogo del POS necesita 2 productos activos");
  return [r.rows[0]!.name, r.rows[1]!.name];
}

/** Crea (o reactiva) a la cajera del relevo, para que corra en CI y en bases recién sembradas. */
async function asegurarCajera() {
  const hash = await hashPassword(CAJERA.password);
  await sql`insert into staff_users(email, full_name, password_hash, role_key, is_active, must_change_password)
            values (${CAJERA.email}, 'Cajera Carrito E2E', ${hash}, 'cashier', true, false)
            on conflict (email) do update set password_hash = excluded.password_hash, role_key = 'cashier',
              is_active = true, must_change_password = false, failed_logins = 0, locked_until = null,
              deleted_at = null`.execute(db);
}

/** Cierra sesión como lo hace una persona: el botón del encabezado, no una petición a mano. */
async function cerrarSesion(page: Page) {
  await page.goto("/pedidos");
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function pedidoConSaldo(total = 8800): Promise<{ id: string; folio: string }> {
  const prod = (
    await sql<{ id: string }>`
      select id from products where deleted_at is null and is_active
       order by created_at limit 1`.execute(db)
  ).rows[0]!;
  const r = await sql<{ id: string; folio: string }>`
    with o as (
      insert into orders(folio, channel, status, payment_status, fulfillment_type,
                         customer_name, customer_phone, subtotal_cents, discount_cents,
                         delivery_fee_cents, tax_cents, tip_cents, total_cents, paid_cents, placed_at)
      values (next_order_folio(), 'web', 'confirmed', 'pending', 'pickup',
              'Carrito E2E', '6645552222', ${total}, 0, 0, 0, 0, ${total}, 0, now())
      returning id, folio)
    insert into order_items(order_id, product_id, product_name, qty, unit_price_cents,
                            discount_cents, total_cents, sort_order)
    select o.id, ${prod.id}::uuid, 'Producto de prueba', 1, ${total}, 0, ${total}, 0 from o
    returning (select id from o) as id, (select folio from o) as folio`.execute(db);
  return r.rows[0]!;
}

test("RF-001 · el carrito en curso sobrevive a salir a cobrar un pedido", async ({ page }) => {
  const p = await pedidoConSaldo();
  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);

  // 1) Se arma una venta en el POS.
  const nombre = await primerProducto();
  await page.goto("/pos");
  await page.getByRole("tab", { name: "Todos" }).click();
  await agregarAlCarrito(page, nombre);
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });

  // 2) El cajero sale a cobrar un pedido: antes esto tiraba el carrito sin aviso.
  await page.goto(`/pos/cobrar/${p.id}`);
  await expect(page.getByTestId("pay-tab-cash")).toBeVisible({ timeout: 15_000 });

  // 3) Al volver, su venta sigue ahí y se le avisa de que se recuperó.
  await page.goto("/pos");
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText(/Se recuperó la venta/i)).toBeVisible({ timeout: 10_000 });
});

test("RF-002 · desde el POS se llega a la cola, y el contador la anuncia", async ({ page }) => {
  const p = await pedidoConSaldo();
  // Se envía a la cola por la base: lo que se prueba es el acceso, no el envío.
  await sql`update orders set pos_queued_at = now() where id = ${p.id}`.execute(db);
  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);
  await page.goto("/pos");
  const acceso = page.getByTestId("pos-pendientes");
  await expect(acceso).toBeVisible({ timeout: 15_000 });
  // El contador dice cuántos esperan: con uno en cola, al menos 1.
  await expect(acceso).toContainText(/[1-9]/);
  await acceso.click();
  await page.waitForURL(/\/pos\/pendientes$/);
  await expect(page.getByText(p.folio)).toBeVisible({ timeout: 15_000 });
});

test("RF-003 · con la caja cerrada, abrirla devuelve al mismo pedido", async ({ page }) => {
  const p = await pedidoConSaldo();
  await login(page, "/dashboard");
  await cerrarCajaSiEstaAbierta(page);

  await page.goto(`/pos/cobrar/${p.id}`);
  // Con la caja cerrada el efectivo no se puede cobrar y el panel lo dice.
  await expect(page.getByText(/La caja está cerrada/i)).toBeVisible({ timeout: 15_000 });

  // El enlace de abrir caja lleva el retorno a ESTE pedido.
  const abrir = page.getByRole("link", { name: /Abrir caja/i }).first();
  await expect(abrir).toHaveAttribute("href", new RegExp(`next=.*${p.id}`));
  await abrir.click();
  await page.waitForURL(/\/caja\?next=/, { timeout: 20_000 });

  // Al abrirla, vuelve al pedido con el panel listo, sin buscarlo otra vez.
  await tecleaNumpad(page, 50000);
  await page.getByTestId("open-register").click();
  await page.waitForURL(new RegExp(`/pos/cobrar/${p.id}$`), { timeout: 20_000 });
  await expect(page.getByTestId("pay-tab-cash")).toBeVisible({ timeout: 15_000 });
});

test("RF-004 · el carrito de un cajero NO se le ofrece al siguiente en la misma tablet", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "desktop", "basta un proyecto para el relevo de turno");
  test.setTimeout(120_000);
  await asegurarCajera();
  const [delAdmin, deLaCajera] = await dosProductos();

  // 1) El admin deja una venta a medias en el punto de venta.
  await login(page, "/dashboard");
  await page.goto("/pos");
  await page.getByRole("tab", { name: "Todos" }).click();
  await agregarAlCarrito(page, delAdmin);
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });

  // 2) Relevo de turno en el MISMO navegador. `localStorage` sobrevive al cierre de sesión —el
  //    cierre es un POST de formulario que no ejecuta nada en el navegador—, así que la separación
  //    tiene que venir de la clave del respaldo.
  await cerrarSesion(page);
  await login(page, "/pos", CAJERA);

  /*
   * 3) La cajera añade LO SUYO.
   *
   * Se comprueba así, y no con "el carrito está vacío", a propósito: `toHaveCount(0)` se cumple en
   * el primer sondeo, antes de que React hidrate y la recuperación tenga ocasión de correr, así que
   * pasaría igual con el fallo presente —comprobado—. Añadir un producto exige una pantalla ya
   * interactiva: a partir de ahí, si el carrito del turno anterior se hubiera recuperado, habría
   * DOS renglones. Uno solo, y el suyo, es la prueba de que nadie heredó la venta de otra persona.
   */
  await page.getByRole("tab", { name: "Todos" }).click();
  await agregarAlCarrito(page, deLaCajera);
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("cart-line").first()).toContainText(deLaCajera);
});

test("RF-005 · dos pestañas del POS no se borran el carrito entre ellas", async ({
  page,
  context,
}) => {
  test.skip(test.info().project.name !== "desktop", "basta un proyecto para dos pestañas");
  test.setTimeout(120_000);
  const [uno, dos] = await dosProductos();
  await login(page, "/dashboard");

  // Pestaña A: una venta.
  await page.goto("/pos");
  await page.getByRole("tab", { name: "Todos" }).click();
  await agregarAlCarrito(page, uno);
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });

  // Pestaña B: misma sesión, mismo navegador, otra venta a la vez.
  const b = await context.newPage();
  await b.goto("/pos");
  await b.getByRole("tab", { name: "Todos" }).click();
  await agregarAlCarrito(b, dos);
  await expect(b.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });

  // Al recargar, cada pestaña recupera LO SUYO. Con un respaldo compartido, la última en guardar
  // habría borrado a la otra y A recuperaría el producto de B.
  await page.reload();
  await expect(page.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("cart-line").first()).toContainText(uno);
  await b.reload();
  await expect(b.getByTestId("cart-line")).toHaveCount(1, { timeout: 15_000 });
  await expect(b.getByTestId("cart-line").first()).toContainText(dos);
  await b.close();
});

test("RF-006 · con la caja YA abierta, el retorno lleva igual al pedido", async ({ page }) => {
  const p = await pedidoConSaldo();
  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);

  // El operador va a abrir la caja y resulta que otro del mostrador ya la abrió. No hay nada que
  // abrir: antes se quedaba en el formulario de CIERRE, sin camino de vuelta al pedido.
  await page.goto(`/caja?next=${encodeURIComponent(`/pos/cobrar/${p.id}`)}`);
  await page.waitForURL(new RegExp(`/pos/cobrar/${p.id}$`), { timeout: 20_000 });
  await expect(page.getByTestId("pay-tab-cash")).toBeVisible({ timeout: 15_000 });

  // Y el retorno sigue acotado a rutas del punto de venta: un destino externo o con `..` no manda a
  // ninguna parte. Nuestro propio dominio no va a servir una redirección abierta.
  await page.goto("/caja?next=https%3A%2F%2Fejemplo.com%2F");
  await expect(page).toHaveURL(/\/caja\?next=/);
  await page.goto("/caja?next=%2Fpos%2F..%2F..%2Fusuarios");
  await expect(page).toHaveURL(/\/caja\?next=/);
});
