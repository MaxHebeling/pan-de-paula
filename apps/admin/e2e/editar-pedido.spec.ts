import { test, expect, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Editar los productos de un pedido ya hecho (0085).
 *
 * Criterio de aceptación tal cual lo pidió Max: sobre un pedido ya hecho, desde el CRM, poder
 * cambiarle el producto, agregar y quitar. Solo administración y gerencia; nunca el cliente.
 *
 * Se prueba en navegador el recorrido completo: abrir el editor, restar, quitar un renglón,
 * agregar otro producto, guardar y ver el pedido actualizado; y que en un pedido YA COBRADO el
 * editor no aparece.
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

/** Tres productos de mostrador con precio y stock: los del pedido y el que entra en el cambio. */
async function productos(): Promise<{ id: string; name: string }[]> {
  const r = await sql<{ id: string; name: string }>`
    select cp.id, cp.name from catalog_products cp
     where cp.is_active and cp.show_on_pos and cp.web_price_cents is not null
     order by cp.sort_order, cp.name limit 3`.execute(db);
  for (const p of r.rows) {
    await sql`insert into inventory_levels(product_id, on_hand) values (${p.id}, 500)
              on conflict (product_id) do update set on_hand = 500`.execute(db);
  }
  expect(r.rows).toHaveLength(3);
  return r.rows;
}

/** Pedido por WhatsApp (precio web, sin exigir que el producto se publique en línea), sin pagar. */
async function pedido(a: string, b: string) {
  return (
    await sql<{ id: string }>`select create_order(${JSON.stringify({
      channel: "whatsapp",
      fulfillment_type: "pickup",
      customer_name: "Editar E2E",
      customer_phone: "6645557777",
      items: [
        { product_id: a, qty: 3 },
        { product_id: b, qty: 1 },
      ],
    })}::jsonb) as id`.execute(db)
  ).rows[0]!.id;
}

const renglones = async (id: string) =>
  (
    await sql<{ product_id: string; qty: string }>`
      select product_id, qty::text from order_items where order_id = ${id} order by sort_order`.execute(
      db,
    )
  ).rows;

test("la administración edita un pedido: resta, quita, agrega y queda registrado", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const [a, b, c] = await productos();
  const id = await pedido(a!.id, b!.id);

  await login(page, "/dashboard");
  await page.goto(`/pedidos/${id}`);
  await page.getByTestId("editar-abrir").click();
  const lista = page.getByTestId("editar-renglones");
  await expect(lista).toBeVisible({ timeout: 15_000 });

  // 3 → 2 del primero, se quita el segundo y se agrega el tercero (= cambiar uno por otro).
  await page.getByRole("button", { name: `Restar uno de ${a!.name}`, exact: true }).click();
  await page.getByRole("button", { name: `Quitar ${b!.name}`, exact: true }).click();
  await expect(page.getByTestId("editar-quitados")).toContainText(b!.name);
  await page.getByTestId("editar-buscar").fill(c!.name);
  await page.getByRole("button", { name: `Agregar ${c!.name}`, exact: true }).click();
  await page.getByTestId("editar-motivo").fill("Cambio pedido por teléfono");

  page.once("dialog", (d) => d.accept());
  await page.getByTestId("editar-guardar").click();
  await expect(page.getByTestId("editar-hecho")).toBeVisible({ timeout: 20_000 });

  const final = await renglones(id);
  expect(final).toEqual([
    { product_id: a!.id, qty: "2.000" },
    { product_id: c!.id, qty: "1.000" },
  ]);
  const reg = await sql<{ reason: string }>`
    select reason from order_item_edits where order_id = ${id}`.execute(db);
  expect(reg.rows).toEqual([{ reason: "Cambio pedido por teléfono" }]);

  // Se deja la base como se encontró: el pedido de prueba no queda abierto para otras suites.
  await sql`update orders set status = 'cancelled' where id = ${id}`.execute(db);
});

test("un pedido ya cobrado NO ofrece editar", async ({ page }) => {
  test.setTimeout(90_000);
  const [a, b] = await productos();
  const id = await pedido(a!.id, b!.id);
  await sql`insert into sales(order_id, channel, subtotal_cents, discount_cents, tax_cents,
                              tip_cents, total_cents, items_count)
            select id, channel, subtotal_cents, 0, 0, 0, total_cents, 4 from orders where id = ${id}`.execute(
    db,
  );

  await login(page, "/dashboard");
  await page.goto(`/pedidos/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("editar-productos")).toHaveCount(0);
});
