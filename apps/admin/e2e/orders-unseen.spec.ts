/**
 * Contador de pedidos sin ver en el sidebar: un pedido que llega solo (web) suma; uno creado por el personal no;
 * abrir su detalle lo descuenta una sola vez; el contador se actualiza sin recargar (sondeo/foco).
 * No asume el estado de la base: todo se mide contra la línea base de /api/orders/unseen-count.
 */
import { test, expect, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

async function login(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
  });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const unseenFromApi = async (page: Page) => {
  const r = await page.request.get("/api/orders/unseen-count");
  expect(r.status()).toBe(200);
  return ((await r.json()) as { unseen: number }).unseen;
};

test("pedidos sin ver: suma al llegar, se descuenta al abrir y se actualiza sin recargar", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "basta un proyecto (misma lógica en móvil)");
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
  const stamp = Date.now().toString().slice(-7);
  try {
    const product = (
      await sql<{ id: string }>`select p.id from products p
        where p.deleted_at is null and p.is_active and current_price_cents(p.id, 'web') is not null
        order by p.name limit 1`.execute(db)
    ).rows[0]!;
    const staff = (
      await sql<{ id: string }>`select id from staff_users where email = ${EMAIL}`.execute(db)
    ).rows[0]!;
    const webOrder = async (tag: string) =>
      (
        await sql<{ id: string }>`select create_order(${JSON.stringify({
          channel: "web",
          customer_name: `Sin ver ${tag} ${stamp}`,
          customer_phone: `664${stamp}`,
          items: [{ product_id: product.id, qty: 1 }],
          idempotency_key: `e2e-unseen-${tag}-${stamp}`,
        })}::jsonb) as id`.execute(db)
      ).rows[0]!.id;

    await login(page, "/dashboard");
    const base = await unseenFromApi(page);

    // Pedido web (sin staff) → suma; pedido capturado por el personal → no suma.
    const first = await webOrder("a");
    await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.staff_id', ${staff.id}, true)`.execute(trx);
      await sql`select create_order(${JSON.stringify({
        channel: "whatsapp",
        customer_name: `Capturado ${stamp}`,
        items: [{ product_id: product.id, qty: 1 }],
        idempotency_key: `e2e-unseen-staff-${stamp}`,
      })}::jsonb)`.execute(trx);
    });
    expect(await unseenFromApi(page)).toBe(base + 1);

    await page.goto("/dashboard");
    const badge = page
      .getByRole("navigation", { name: "Principal" })
      .first()
      .getByTestId("orders-unseen-badge");
    await expect(badge).toHaveText(String(base + 1));
    await expect(badge).toHaveAccessibleName(/sin ver/);

    // Llega otro pedido sin recargar: al volver a la pestaña el contador se actualiza.
    const second = await webOrder("b");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(badge).toHaveText(String(base + 2));

    // La lista marca el pedido como Nuevo; abrir el detalle lo descuenta.
    const folio = (
      await sql<{ folio: string }>`select folio from orders where id = ${first}::uuid`.execute(db)
    ).rows[0]!.folio;
    await page.goto(`/pedidos?q=${encodeURIComponent(folio)}`);
    await expect(page.getByTestId(`order-row-${folio}`)).toContainText("Nuevo");
    await page.getByRole("link", { name: folio }).click();
    await page.waitForURL(new RegExp(`/pedidos/${first}$`));
    await expect(badge).toHaveText(String(base + 1));

    // Volver a abrirlo no descuenta de nuevo; queda registrado quién lo vio primero.
    await page.reload();
    await expect(badge).toHaveText(String(base + 1));
    const views = await sql<{ n: number; staff_id: string | null }>`
      select count(*)::int as n, max(staff_id::text) as staff_id from order_first_views where order_id = ${first}::uuid`.execute(
      db,
    );
    expect(views.rows[0]).toEqual({ n: 1, staff_id: staff.id });

    await page.goto(`/pedidos/${second}`);
    if (base === 0) await expect(badge).toBeHidden();
    else await expect(badge).toHaveText(String(base));

    // Sin sesión no se expone el contador.
    const anon = await page.context().browser()!.newContext({ baseURL: info.project.use.baseURL });
    expect((await anon.request.get("/api/orders/unseen-count")).status()).toBe(401);
    await anon.close();
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
});
