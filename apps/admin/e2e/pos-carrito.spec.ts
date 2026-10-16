import { test, expect, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Tres huecos del recorrido Pedidos → Punto de Venta, detectados al analizarlo:
 *
 *  RF-001 · el carrito en curso del POS se destruía al salir a cobrar un pedido;
 *  RF-002 · desde el POS no había acceso a la cola de pendientes;
 *  RF-003 · abrir la caja desde el panel de cobro abandonaba el pedido.
 *
 * Los tres son pérdida de trabajo del cajero, así que se prueban en navegador: es donde ocurren.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026",
};

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

async function login(page: Page, next = "/dashboard") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("domcontentloaded");
  for (let i = 0; i < 4; i++) {
    await fillField(page, "Correo", ADMIN.email);
    await fillField(page, "Contraseña", ADMIN.password);
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
