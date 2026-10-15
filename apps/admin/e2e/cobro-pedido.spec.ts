import { test, expect, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Cobro de un pedido guardado desde la caja del punto de venta.
 *
 * El criterio de aceptación del flujo, tal cual: dado un pedido con saldo, un operador autorizado
 * y una caja abierta, al pulsar «Enviar a Punto de Venta» se abre DIRECTAMENTE la pantalla de cobro
 * con sus medios de pago, sin buscar el pedido ni pulsar nada intermedio.
 *
 * Se prueba en navegador porque es lo único que puede demostrarlo: que el redirect ocurre, que el
 * panel aparece abierto solo, y que el cobro actualiza el pedido original.
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

/** El primer `.fill()` se pierde al hidratar React, así que se reintenta (igual que audit-ops). */
async function fillField(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  for (let i = 0; i < 5; i++) {
    await field.fill(value);
    await page.waitForTimeout(120);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${label}"`);
}

async function login(page: Page, next = "/dashboard") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("domcontentloaded");
  for (let intento = 0; intento < 4; intento++) {
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

async function abrirCajaSiHaceFalta(page: Page, cents = 50000) {
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await page.getByRole("button", { name: "Borrar todo" }).first().click();
    for (const dig of String(cents))
      await page.getByRole("button", { name: dig, exact: true }).click();
    await page.getByTestId("open-register").click();
    await page.waitForURL(/\/caja\?abierta=1/);
  }
  await expect(page.getByTestId("register-close-form")).toBeVisible();
}

/** Pedido con saldo, creado por la base: la prueba es del cobro, no del alta. */
async function pedidoConSaldo(total = 12345): Promise<{ id: string; folio: string }> {
  const prod = (
    await sql<{ id: string }>`
      select id from products where deleted_at is null and is_active
       order by created_at limit 1`.execute(db)
  ).rows[0]!;
  const r = await sql<{ id: string; folio: string }>`
    with o as (
      insert into orders(folio, channel, status, payment_status, fulfillment_type,
                         customer_name, customer_phone,
                         subtotal_cents, discount_cents, delivery_fee_cents, tax_cents, tip_cents,
                         total_cents, paid_cents, placed_at)
      values (next_order_folio(), 'web', 'confirmed', 'pending', 'pickup',
              'Cobro E2E', '6645550000',
              ${total}, 0, 0, 0, 0, ${total}, 0, now())
      returning id, folio
    )
    insert into order_items(order_id, product_id, product_name, qty, unit_price_cents,
                            discount_cents, total_cents, sort_order)
    select o.id, ${prod.id}::uuid, 'Producto de prueba', 1, ${total}, 0, ${total}, 0 from o
    returning (select id from o) as id, (select folio from o) as folio`.execute(db);
  return r.rows[0]!;
}

const saldo = async (id: string) =>
  (
    await sql<{
      saldo: number;
      payment_status: string;
    }>`select (total_cents - paid_cents) as saldo, payment_status::text as payment_status
         from orders where id = ${id}`.execute(db)
  ).rows[0]!;

test("enviar al punto de venta abre la caja con el pedido y el cobro actualiza el pedido", async ({
  page,
}) => {
  const p = await pedidoConSaldo(12345);
  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);

  // 1) Detalle del pedido: el botón está a la vista, sin buscarlo en un menú.
  await page.goto(`/pedidos/${p.id}`);
  const enviar = page.getByRole("button", { name: /Enviar a Punto de Venta/i });
  await expect(enviar).toBeVisible();

  // 2) Un solo clic lleva a la caja: ni lista intermedia ni segundo botón.
  await enviar.click();
  await page.waitForURL(new RegExp(`/pos/cobrar/${p.id}$`), { timeout: 20_000 });

  // 3) El panel de pagos aparece ABIERTO solo, con los medios disponibles.
  await expect(page.getByTestId("pay-tab-cash")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pay-tab-card_terminal")).toBeVisible();
  await expect(page.getByTestId("pay-tab-transfer")).toBeVisible();

  // 4) Cobro en efectivo del saldo. En la pestaña de efectivo no hay botón `confirm-payment`: se
  //    teclea el recibido y se cobra con el Enter del teclado numérico. "Exacto" pone el importe justo.
  await page.getByTestId("pay-tab-cash").click();
  await page.getByRole("button", { name: "Exacto" }).click();
  await page.getByRole("button", { name: "Cobrar" }).click();

  // 5) El pedido queda pagado, y se lo dice al operador.
  await expect(page.getByTestId("cobro-resultado")).toBeVisible({ timeout: 20_000 });
  const despues = await saldo(p.id);
  expect(despues.saldo).toBe(0);
  expect(despues.payment_status).toBe("paid");

  // 6) Una sola venta para ese pedido: cobrar no duplicó nada.
  const ventas = await sql<{
    n: number;
  }>`select count(*)::int as n from sales where order_id = ${p.id} and voided_at is null`.execute(
    db,
  );
  expect(ventas.rows[0]!.n).toBe(1);
});

test("con anticipo, la caja abre con el SALDO y no con el total", async ({ page }) => {
  const p = await pedidoConSaldo(25000);
  // Anticipo de $100 sobre $250: deben quedar $150 por cobrar.
  await sql`update orders set paid_cents = 10000, payment_status = 'partial' where id = ${p.id}`.execute(
    db,
  );
  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);
  await page.goto(`/pedidos/${p.id}`);
  await page.getByRole("button", { name: /Enviar a Punto de Venta/i }).click();
  await page.waitForURL(new RegExp(`/pos/cobrar/${p.id}$`), { timeout: 20_000 });
  // El panel cobra 150.00, no 250.00.
  await expect(page.getByTestId("checkout-total")).toContainText("150");
});

test("un pedido ya pagado no ofrece cobrarlo otra vez", async ({ page }) => {
  const p = await pedidoConSaldo(5000);
  await sql`update orders set paid_cents = 5000, payment_status = 'paid' where id = ${p.id}`.execute(
    db,
  );
  await login(page, "/dashboard");
  await page.goto(`/pedidos/${p.id}`);
  await expect(page.getByRole("button", { name: /Enviar a Punto de Venta/i })).toHaveCount(0);
  await expect(page.getByText(/Pagado/).first()).toBeVisible();
  // Y entrando a la pantalla de cobro directo, tampoco.
  await page.goto(`/pos/cobrar/${p.id}`);
  await expect(page.getByText(/ya está pagado/i).first()).toBeVisible();
  await expect(page.getByTestId("pay-tab-cash")).toHaveCount(0);
});
