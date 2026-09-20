import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDb, sql, type Database } from "@pdp/db";

/**
 * Seguimiento del pedido en el portal, de extremo a extremo y SIN recargar la página.
 *
 * El criterio de aceptación completo: el cliente entra a su portal, ve su pedido, la panadería lo
 * mueve desde la base por el mismo camino que usa el CRM (`change_order_status`) y el portal se
 * actualiza solo, con su aviso y su línea de tiempo. Y lo contrario con la misma fuerza: el pedido
 * de otra persona no se abre ni escribiendo su folio.
 *
 * Requiere el sitio corriendo (E2E_WEB_URL) y DATABASE_URL apuntando a la MISMA base.
 */
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Database;
let pool: { end: () => Promise<void> };
let staff: string;
let producto: string;

test.beforeAll(async () => {
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 }));
  const id = stamp();
  staff = (
    await sql<{ id: string }>`
      insert into staff_users(email, full_name, password_hash, role_key)
      values (${`e2e-vivo-${id}@pdp.local`}, 'E2E Vivo', 'x', 'owner') returning id`.execute(db)
  ).rows[0]!.id;
  producto = (
    await sql<{ id: string }>`
      insert into products(name, slug, track_stock, is_active)
      values (${`Concha Vivo ${id}`}, ${`concha-vivo-${id}`}, false, true) returning id`.execute(db)
  ).rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents)
            values (${producto}, 'all', 'regular', 3500)`.execute(db);
});

test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Cliente con pedido, como lo crearía el sitio o el CRM. */
async function sembrar(tag: string) {
  const id = stamp();
  const email = `vivo-${tag}-${id}@example.com`;
  const cliente = (
    await sql<{ r: { customer_id: string } }>`
      select register_customer(${JSON.stringify({
        full_name: `Cliente Vivo ${tag} ${id}`,
        email,
        phone: `664${String(id).slice(-7)}`,
        birthday: "1990-06-15",
      })}::jsonb) as r`.execute(db)
  ).rows[0]!.r;
  const orderId = (
    await sql<{ id: string }>`
      select create_order(${JSON.stringify({
        channel: "web",
        customer_id: cliente.customer_id,
        customer_name: `Cliente Vivo ${tag}`,
        customer_phone: `664${String(id).slice(-7)}`,
        items: [{ product_id: producto, qty: 3 }],
        idempotency_key: `e2e-vivo-${tag}-${id}`,
      })}::jsonb) as id`.execute(db)
  ).rows[0]!.id;
  const folio = (
    await sql<{ folio: string }>`select folio from orders where id = ${orderId}`.execute(db)
  ).rows[0]!.folio;
  return { customerId: cliente.customer_id, orderId, folio, email };
}

/** Mueve el pedido igual que el CRM: misma función SQL, mismo historial, mismos avisos. */
async function mover(orderId: string, to: string) {
  await sql`select set_config('app.staff_id', ${staff}, false)`.execute(db);
  await sql`select change_order_status(${orderId}::uuid, ${to}::order_status, null)`.execute(db);
}

/** Entra al portal con un enlace de acceso sembrado (el token en claro solo vive en el correo). */
async function entrar(page: Page, customerId: string) {
  const token = `e2e-${stamp()}-${"x".repeat(20)}`;
  await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
            values (${customerId}, ${sha256(token)}, now() + interval '1 hour')`.execute(db);
  await page.goto(`/portal/acceso?t=${encodeURIComponent(token)}`);
  await page.getByTestId("portal-acceso-confirmar").click();
  await page.waitForURL(/\/portal(\?|$)/, { timeout: 20_000 });
}

test("el pedido se sigue en vivo: cambia en el CRM y el portal se entera solo", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const c = await sembrar("a");
  await entrar(page, c.customerId);

  // 1) El pedido aparece en su portal sin que nadie lo vincule a mano.
  await page.goto("/portal/pedidos");
  const tarjeta = page.getByTestId(`portal-order-${c.folio}`);
  await expect(tarjeta).toBeVisible();
  await expect(page.getByTestId(`portal-order-status-${c.folio}`)).toHaveText("Nuevo");

  // 2) La panadería lo confirma: el portal se actualiza SIN recargar (sondeo cada 10 s).
  await mover(c.orderId, "confirmed");
  await expect(page.getByTestId(`portal-order-status-${c.folio}`)).toHaveText("Confirmado", {
    timeout: 30_000,
  });
  // Y con ello llega su aviso, con el contador de la campana.
  await expect(page.getByTestId("portal-avisos-badge")).toHaveText("1", { timeout: 30_000 });

  // 3) Seguimiento: línea de tiempo con lo cumplido, lo actual y lo que falta.
  await tarjeta.click();
  await page.waitForURL(new RegExp(`/portal/pedidos/${c.folio}$`));
  await expect(page.getByTestId("paso-received")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("paso-confirmed")).toHaveAttribute("data-state", "current");
  await expect(page.getByTestId("paso-ready")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("portal-order-total")).toContainText("105");

  // Abrir el seguimiento marca sus avisos como leídos: la campana se apaga.
  await expect(page.getByTestId("portal-avisos-badge")).toHaveCount(0, { timeout: 30_000 });

  // 4) En preparación y listo: el cliente lo ve en la misma pantalla, sin tocar nada.
  await mover(c.orderId, "in_production");
  await expect(page.getByTestId("paso-preparing")).toHaveAttribute("data-state", "current", {
    timeout: 30_000,
  });
  await mover(c.orderId, "ready_for_pickup");
  await expect(page.getByTestId("paso-ready")).toHaveAttribute("data-state", "current", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("paso-preparing")).toHaveAttribute("data-state", "done");

  // 5) Los avisos quedan en su centro, con el texto que define la base (uno por cambio).
  await page.goto("/portal/avisos");
  const avisos = page.getByTestId("portal-avisos").getByRole("listitem");
  await expect(avisos).toHaveCount(3);
  await expect(page.getByTestId("aviso-ready_for_pickup")).toContainText("¡Tu pedido está listo!");
  await expect(page.getByTestId("aviso-ready_for_pickup")).toContainText(c.folio);
});

test("el pedido de otro cliente no se abre ni escribiendo su folio", async ({ page }) => {
  test.setTimeout(120_000);
  const mio = await sembrar("b");
  const ajeno = await sembrar("c");
  await mover(ajeno.orderId, "confirmed");

  await entrar(page, mio.customerId);
  await page.goto("/portal/pedidos");
  await expect(page.getByTestId(`portal-order-${mio.folio}`)).toBeVisible();
  await expect(page.getByTestId(`portal-order-${ajeno.folio}`)).toHaveCount(0);

  // Con el folio ajeno en la URL: 404, y sin filtrar ni una pista.
  const res = await page.request.get(`/portal/pedidos/${ajeno.folio}`);
  expect(res.status()).toBe(404);
  expect(await res.text()).not.toContain("Cliente Vivo c");

  // El pulso tampoco se entera de lo ajeno.
  const pulso = await page.request.get("/api/portal/pulso");
  expect(pulso.status()).toBe(200);
  const cuerpo = (await pulso.json()) as { orders: Array<{ folio: string }> };
  expect(cuerpo.orders.map((o) => o.folio)).toEqual([mio.folio]);

  // Y sin sesión no hay pulso que valga.
  const anon = await page.context().browser()!.newContext();
  expect((await anon.request.get(`${new URL(page.url()).origin}/api/portal/pulso`)).status()).toBe(
    401,
  );
  await anon.close();
});
