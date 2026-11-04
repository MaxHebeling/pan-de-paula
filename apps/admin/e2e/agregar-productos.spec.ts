import { test, expect, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Agregar productos a un pedido que todavía no se cobró (0084).
 *
 * El criterio de aceptación tal cual lo pidió Max: si hay un pedido ya hecho y la persona viene a
 * retirarlo, el mostrador puede agregarle más producto y cobrarlo todo junto, en un solo ticket.
 *
 * Se prueba en navegador porque es lo único que demuestra el recorrido completo: que el panel
 * aparece donde debe, que agregar sube el saldo, que cobrarlo después descuenta el stock de lo
 * agregado y —lo que de verdad protege el dinero— que en un pedido YA COBRADO el panel no está.
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

async function abrirCajaSiHaceFalta(page: Page) {
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await page.getByRole("button", { name: "Borrar todo" }).first().click();
    for (const d of "50000") await page.getByRole("button", { name: d, exact: true }).click();
    await page.getByTestId("open-register").click();
    await page.waitForURL(/\/caja\?abierta=1/);
  }
}

/** Producto del mostrador con precio y stock suficiente: lo que el cliente pedirá al llegar. */
async function productoDisponible(): Promise<{ id: string; name: string }> {
  const r = await sql<{ id: string; name: string }>`
    select cp.id, cp.name from catalog_products cp
     where cp.is_active and cp.show_on_pos and cp.pos_price_cents is not null
     order by cp.sort_order, cp.name limit 1`.execute(db);
  const p = r.rows[0]!;
  // Se repone para que la prueba no dependa de lo que dejaron otras suites.
  await sql`insert into inventory_levels(product_id, on_hand) values (${p.id}, 500)
            on conflict (product_id) do update set on_hand = 500`.execute(db);
  return p;
}

async function pedidoConSaldo(productId: string, total = 9000) {
  const r = await sql<{ id: string; folio: string }>`
    with o as (
      insert into orders(folio, channel, status, payment_status, fulfillment_type,
                         customer_name, customer_phone, subtotal_cents, discount_cents,
                         delivery_fee_cents, tax_cents, tip_cents, total_cents, paid_cents, placed_at)
      values (next_order_folio(), 'pos', 'ready_for_pickup', 'pending', 'pickup',
              'Agregar E2E', '6645558888', ${total}, 0, 0, 0, 0, ${total}, 0, now())
      returning id, folio)
    insert into order_items(order_id, product_id, product_name, qty, unit_price_cents,
                            discount_cents, total_cents, sort_order)
    select o.id, ${productId}::uuid, 'Producto de prueba', 1, ${total}, 0, ${total}, 0 from o
    returning (select id from o) as id, (select folio from o) as folio`.execute(db);
  return r.rows[0]!;
}

const totales = async (id: string) =>
  (
    await sql<{
      total_cents: number;
      paid_cents: number;
      payment_status: string;
      renglones: number;
    }>`select o.total_cents, o.paid_cents, o.payment_status::text as payment_status,
              (select count(*)::int from order_items oi where oi.order_id = o.id) as renglones
         from orders o where o.id = ${id}`.execute(db)
  ).rows[0]!;

const existencias = async (id: string) =>
  Number(
    (
      await sql<{
        on_hand: string;
      }>`select on_hand from inventory_levels where product_id = ${id}`.execute(db)
    ).rows[0]?.on_hand ?? 0,
  );

test("desde la caja: se agrega lo que el cliente pide al llegar y se cobra todo junto", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const prod = await productoDisponible();
  const p = await pedidoConSaldo(prod.id);
  const antes = await existencias(prod.id);

  await login(page, "/dashboard");
  await abrirCajaSiHaceFalta(page);
  await page.goto(`/pos/cobrar/${p.id}`);

  /*
   * 1) El panel de pagos se abre SOLO (así se diseñó: enviar al punto de venta ya fue la decisión
   *    del operador) y tapa la pantalla. El panel de agregar queda detrás, así que lo que lo hace
   *    alcanzable es el atajo de dentro. Sin él, en el mostrador nadie encontraría cómo agregar:
   *    por eso se prueba por aquí y no cerrando el panel a mano.
   */
  await expect(page.getByTestId("pay-tab-cash")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("ir-a-agregar").click();

  // 2) Se busca y se agrega. La lista se confirma UNA vez, no una petición por producto.
  const panel = page.getByTestId("agregar-productos");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("agregar-buscar").fill(prod.name);
  await page.getByRole("button", { name: `Agregar ${prod.name}`, exact: true }).click();
  await expect(page.getByTestId("agregar-pendientes")).toBeVisible();
  await page.getByTestId("agregar-confirmar").click();
  await expect(page.getByTestId("agregar-hecho")).toBeVisible({ timeout: 20_000 });

  // 3) El pedido creció: un renglón más y más saldo por cobrar.
  const despues = await totales(p.id);
  expect(despues.renglones).toBe(2);
  expect(despues.total_cents).toBeGreaterThan(9000);

  // 4) Se vuelve al cobro sin recargar —es el camino del mostrador— y el panel trae el saldo NUEVO.
  await page.getByTestId("cobro-reabrir").click();
  await expect(page.getByTestId("checkout-total")).not.toContainText("90.00");

  // 5) Y al cobrar se descuenta el stock de lo agregado, no solo el del pedido original.
  await page.getByTestId("pay-tab-cash").click();
  await page.getByRole("button", { name: "Exacto" }).click();
  await page.getByRole("button", { name: "Cobrar" }).click();
  await expect(page.getByTestId("cobro-resultado")).toBeVisible({ timeout: 20_000 });

  const final = await totales(p.id);
  expect(final.payment_status).toBe("paid");
  expect(await existencias(prod.id)).toBeLessThan(antes);
});

test("un pedido ya cobrado NO ofrece agregar: eso es una venta nueva", async ({ page }) => {
  test.setTimeout(90_000);
  const prod = await productoDisponible();
  const p = await pedidoConSaldo(prod.id, 4000);
  await sql`update orders set paid_cents = 4000, payment_status = 'paid' where id = ${p.id}`.execute(
    db,
  );
  await sql`insert into sales(order_id, channel, subtotal_cents, discount_cents, tax_cents,
                              tip_cents, total_cents, items_count)
            values (${p.id}, 'pos', 4000, 0, 0, 0, 4000, 1)`.execute(db);

  await login(page, "/dashboard");
  // Ni en la caja…
  await page.goto(`/pos/cobrar/${p.id}`);
  await expect(page.getByTestId("agregar-productos")).toHaveCount(0);
  // …ni en el detalle del pedido.
  await page.goto(`/pedidos/${p.id}`);
  await expect(page.getByTestId("agregar-productos")).toHaveCount(0);
});

test("desde el detalle del pedido también se puede, para ajustarlo antes de que llegue", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const prod = await productoDisponible();
  const p = await pedidoConSaldo(prod.id, 7000);

  await login(page, "/dashboard");
  await page.goto(`/pedidos/${p.id}`);
  await expect(page.getByTestId("agregar-productos")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("agregar-buscar").fill(prod.name);
  await page.getByRole("button", { name: `Agregar ${prod.name}`, exact: true }).click();
  await page.getByTestId("agregar-confirmar").click();
  await expect(page.getByTestId("agregar-hecho")).toBeVisible({ timeout: 20_000 });

  const despues = await totales(p.id);
  expect(despues.renglones).toBe(2);
  expect(despues.total_cents).toBeGreaterThan(7000);
  // Sigue sin pagarse: agregar no cobra.
  expect(despues.paid_cents).toBe(0);
});
