import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createDb, sql, withStaff, type Database } from "@pdp/db";

/**
 * Portal del cliente de extremo a extremo.
 *
 * El test crea SUS PROPIOS datos (no asume seed): un cliente con correo, otro cliente distinto y una
 * venta de mostrador hecha con la misma función SQL del POS real (`pos_checkout`), para comprobar que
 * lo que el portal muestra sale de la operación y no de datos de prueba a modo.
 *
 * El enlace de acceso se "siembra" insertando su sha256 (el token en claro solo existe en el correo).
 * Así se prueba el canje real de /portal/acceso sin depender de Resend, que hoy no está configurado.
 */

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Fixture = {
  customerId: string;
  email: string;
  fullName: string;
  publicCode: string;
  qrToken: string;
  folio: string;
  otherFolio: string;
};

async function seedFixture(db: Database): Promise<Fixture> {
  const id = stamp();
  const staff = (
    await sql<{ id: string }>`
      insert into staff_users(email, full_name, password_hash, role_key)
      values (${`e2e-portal-${id}@pdp.local`}, 'E2E Portal', 'x', 'owner') returning id`.execute(db)
  ).rows[0]!.id;
  const product = (
    await sql<{ id: string }>`
      insert into products(name, slug, track_stock, is_active)
      values (${`Croissant E2E ${id}`}, ${`croissant-e2e-${id}`}, false, true) returning id`.execute(
      db,
    )
  ).rows[0]!.id;
  await sql`insert into product_prices(product_id, channel, kind, price_cents)
            values (${product}, 'all', 'regular', 4500)`.execute(db);

  const mine = (
    await sql<{ r: { customer_id: string; public_code: string; qr_token: string } }>`
      select register_customer(${JSON.stringify({
        full_name: `Portal E2E ${id}`,
        email: `portal-e2e-${id}@example.com`,
        phone: `664${String(id).slice(-7)}`,
        birthday: "1990-06-15",
        source: "qr",
      })}::jsonb) as r`.execute(db)
  ).rows[0]!.r;
  const other = (
    await sql<{ r: { customer_id: string } }>`
      select register_customer(${JSON.stringify({
        full_name: `Ajeno E2E ${id}`,
        email: `ajeno-e2e-${id}@example.com`,
        phone: `665${String(id).slice(-7)}`,
        birthday: "1991-07-16",
        source: "qr",
      })}::jsonb) as r`.execute(db)
  ).rows[0]!.r;

  const checkout = (customerId: string, qty: number, cents: number) =>
    withStaff(db, staff, async (trx) => {
      const r = await sql<{ r: { folio: string } }>`
        select pos_checkout(${JSON.stringify({
          customer_id: customerId,
          items: [{ product_id: product, qty }],
          payments: [{ provider: "cash", method: "cash", amount_cents: cents }],
        })}::jsonb) as r`.execute(trx);
      return r.rows[0]!.r.folio;
    });

  return {
    customerId: mine.customer_id,
    email: `portal-e2e-${id}@example.com`,
    fullName: `Portal E2E ${id}`,
    publicCode: mine.public_code,
    qrToken: mine.qr_token,
    folio: await checkout(mine.customer_id, 2, 9000),
    otherFolio: await checkout(other.customer_id, 1, 4500),
  };
}

/** Siembra un enlace de acceso válido y devuelve la URL tal como le llegaría al cliente. */
async function plantAccessLink(db: Database, customerId: string): Promise<string> {
  const token = `e2e-${stamp()}-${"x".repeat(20)}`;
  await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
            values (${customerId}, ${sha256(token)}, now() + interval '1 hour')`.execute(db);
  return `/portal/acceso?t=${encodeURIComponent(token)}`;
}

async function enter(page: Page, link: string) {
  await page.goto(link);
  await page.getByTestId("portal-acceso-confirmar").click();
  await page.waitForURL(/\/portal(\?|$)/, { timeout: 20_000 });
}

test.describe("portal del cliente", () => {
  let db: Database;
  let pool: { end: () => Promise<void> };
  let f: Fixture;

  test.beforeAll(async () => {
    ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 }));
    f = await seedFixture(db);
  });
  test.afterAll(async () => {
    await db.destroy();
    await pool.end().catch(() => {});
  });

  test("pedir enlace, entrar, ver puntos/QR/compras, cerrar sesión", async ({ page }) => {
    // 1) Pedir el enlace: la respuesta es genérica y no revela nada de la cuenta.
    await page.goto("/portal/entrar");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Entra a tu cuenta");
    await page.getByTestId("portal-email").fill(f.email);
    await page.getByTestId("portal-submit").click();
    await expect(page.getByTestId("portal-link-sent")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("portal-link-sent")).toContainText("Revisa tu correo");

    // El enlace existe en la base (solo su hash) aunque el correo no esté configurado.
    const emitted = await sql<{ n: number }>`
      select count(*)::int as n from customer_access_tokens where customer_id = ${f.customerId}`.execute(
      db,
    );
    expect(emitted.rows[0]!.n).toBeGreaterThan(0);

    // 2) Entrar con el enlace.
    await enter(page, await plantAccessLink(db, f.customerId));
    await expect(page.getByTestId("portal-bienvenida")).toBeVisible();
    await expect(page.getByTestId("portal-greeting")).toContainText("Hola, Portal");

    // 3) Inicio: nivel con su color real, puntos, QR y código público.
    await expect(page.getByTestId("portal-tier")).toBeVisible();
    await expect(page.getByTestId("portal-tier")).toHaveAttribute(
      "data-tier-color",
      /gray|blue|amber|green/,
    );
    await expect(page.getByTestId("portal-points")).toHaveText("9");
    await expect(page.getByTestId("portal-qr")).toBeVisible();
    await expect(page.getByTestId("portal-code")).toHaveText(f.publicCode);

    // 4) Compras y detalle.
    await page.getByTestId("portal-nav-compras").click();
    await page.waitForURL(/\/portal\/compras$/);
    await expect(page.getByTestId(`portal-compra-${f.folio}`)).toBeVisible();
    await expect(page.getByTestId("portal-compras").getByRole("listitem")).toHaveCount(1);
    await page.getByTestId(`portal-compra-${f.folio}`).click();
    await page.waitForURL(new RegExp(`/portal/compras/${f.folio}$`));
    await expect(page.getByTestId("portal-detalle-folio")).toHaveText(f.folio);
    await expect(page.getByTestId("portal-detalle-items")).toContainText("Croissant E2E");
    await expect(page.getByTestId("portal-detalle-items")).toContainText("2 ×");
    await expect(page.getByTestId("portal-detalle-total")).toContainText("90.00");
    await expect(page.getByTestId("portal-detalle-pagos")).toContainText("Efectivo");
    await expect(page.getByTestId("portal-detalle-puntos")).toHaveText("+9");

    // 5) Puntos.
    await page.getByTestId("portal-nav-puntos").click();
    await page.waitForURL(/\/portal\/puntos$/);
    await expect(page.getByTestId("portal-saldo")).toHaveText("9");
    await expect(page.getByTestId("portal-movimientos").getByRole("listitem")).toHaveCount(1);
    await expect(page.getByTestId("portal-movimientos")).toContainText("Puntos por tu compra");
    await expect(page.getByTestId("portal-movimientos")).toContainText(f.folio);

    // 6) Perfil: código, alta y canal de registro reales.
    await page.getByTestId("portal-nav-perfil").click();
    await page.waitForURL(/\/portal\/perfil$/);
    await expect(page.getByTestId("perfil-codigo")).toHaveText(f.publicCode);
    await expect(page.getByTestId("perfil-correo")).toHaveText(f.email);
    await expect(page.getByTestId("perfil-origen")).toHaveText("Con el QR del club");
    await expect(page.getByTestId("perfil-alta")).not.toBeEmpty();

    // 7) La compra de OTRO cliente no existe para esta sesión.
    const ajena = await page.goto(`/portal/compras/${f.otherFolio}`);
    expect(ajena?.status()).toBe(404);

    // 8) Cerrar sesión: la sesión queda revocada y /portal vuelve a pedir el enlace.
    await page.goto("/portal");
    await page.getByTestId("portal-logout").click();
    await page.waitForURL(/\/portal\/entrar\?salir=1$/);
    await expect(page.getByTestId("portal-notice")).toBeVisible();
    await page.goto("/portal");
    await page.waitForURL(/\/portal\/entrar$/);
    await expect(page.getByTestId("portal-email")).toBeVisible();
  });

  test("sin sesión, todas las páginas del portal mandan a /portal/entrar", async ({ page }) => {
    for (const path of ["/portal", "/portal/perfil", "/portal/compras", "/portal/puntos"]) {
      await page.goto(path);
      await page.waitForURL(/\/portal\/entrar$/);
      await expect(page.getByTestId("portal-email")).toBeVisible();
    }
    // Incluso con el folio correcto de un cliente real: sin cookie no hay datos.
    await page.goto(`/portal/compras/${f.folio}`);
    await page.waitForURL(/\/portal\/entrar$/);
  });

  test("un enlace de acceso sirve una sola vez", async ({ page }) => {
    const link = await plantAccessLink(db, f.customerId);
    await enter(page, link);
    await expect(page.getByTestId("portal-points")).toBeVisible();
    // Sesión nueva (sin cookies) y el mismo enlace: ya no abre nada.
    await page.context().clearCookies();
    await page.goto(link);
    await page.getByTestId("portal-acceso-confirmar").click();
    await page.waitForURL(/\/portal\/entrar\?expirado=1$/);
    await expect(page.getByTestId("portal-notice")).toContainText("ya no sirve");
  });

  test("/mi-tarjeta/[token] sigue funcionando igual que antes", async ({ page }) => {
    await page.goto(`/mi-tarjeta/${encodeURIComponent(f.qrToken)}`);
    await expect(page.getByTestId("card-name")).toHaveText(f.fullName);
    await expect(page.getByTestId("card-code")).toHaveText(f.publicCode);
    await expect(page.getByTestId("card-qr")).toBeVisible();
    await expect(page.getByTestId("card-points")).toHaveText("9");
    const res = await page.request.get(
      `${new URL(page.url()).origin}/mi-tarjeta/token-que-no-existe`,
    );
    expect(res.status()).toBe(404);
  });

  test("/unete exige los datos completos y el alta nueva entra al portal con ese correo", async ({
    page,
  }) => {
    const id = stamp();
    await page.goto("/unete");
    await page.getByTestId("join-name").fill(`Nueva Portal ${id}`);
    await page.getByTestId("join-phone").fill(`66${String(id).slice(-8)}`);
    await page.getByTestId("join-submit").click();
    // Sin correo, el formulario no deja pasar y lo dice con claridad.
    await expect(page.locator('[role="alert"].error')).toContainText(/correo/i);

    await page.getByTestId("join-email").fill(`nueva-portal-${id}@example.com`);
    await page.getByTestId("join-submit").click();
    // Y tampoco sin fecha de nacimiento (migración 0045).
    await expect(page.locator('[role="alert"].error')).toContainText(/fecha de nacimiento/i);
    await page.getByTestId("join-birthday").fill("1994-09-30");
    await page.getByTestId("join-submit").click();
    await expect(page).toHaveURL(/\/mi-tarjeta\/.+\?bienvenida=1/, { timeout: 20_000 });

    const row = await sql<{ id: string; email: string }>`
      select id, email from customers where email = ${`nueva-portal-${id}@example.com`}`.execute(
      db,
    );
    expect(row.rows).toHaveLength(1);

    // Y ese correo ya abre el portal.
    await enter(page, await plantAccessLink(db, row.rows[0]!.id));
    await expect(page.getByTestId("portal-greeting")).toContainText("Hola, Nueva");
    await expect(page.getByTestId("portal-points")).toHaveText("0");
  });

  test("cliente histórico incompleto: completa sus datos desde su propio portal", async ({
    page,
  }) => {
    const id = stamp();
    // Alta como la de antes de la regla: sin fecha de nacimiento (y con correo para poder entrar).
    const r = await sql<{ r: { customer_id: string } }>`
      select register_customer(${JSON.stringify({
        full_name: `Historico Portal ${id}`,
        email: `historico-portal-${id}@example.com`,
        allow_incomplete: true,
      })}::jsonb) as r`.execute(db);
    const customerId = r.rows[0]!.r.customer_id;

    await enter(page, await plantAccessLink(db, customerId));
    await page.goto("/portal/perfil");
    await expect(page.getByTestId("perfil-telefono")).toHaveText("Nos falta");
    await expect(page.getByTestId("perfil-cumpleanos")).toHaveText("Nos falta");

    const form = page.getByTestId("portal-completar");
    await expect(form).toBeVisible();
    await form.getByTestId("portal-phone").fill(`667${String(id).slice(-7)}`);
    await form.getByTestId("portal-birthday").fill("1987-01-23");
    await form.getByRole("button", { name: "Guardar mis datos" }).click();
    await expect(page.getByRole("status")).toContainText(/quedaron tus datos/i, {
      timeout: 20_000,
    });

    const c = await sql<{ phone: string; birthday: string }>`
      select phone::text as phone, to_char(birthday,'YYYY-MM-DD') as birthday
        from customers where id = ${customerId}`.execute(db);
    expect(c.rows[0]).toEqual({ phone: `667${String(id).slice(-7)}`, birthday: "1987-01-23" });

    // Ya completo, el portal deja de pedírselos.
    await page.goto("/portal/perfil");
    await expect(page.getByTestId("portal-completar")).toHaveCount(0);
    await expect(page.getByTestId("perfil-cumpleanos")).not.toHaveText("Nos falta");
  });
});
