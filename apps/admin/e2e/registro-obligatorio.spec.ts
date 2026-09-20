/**
 * Alta de cliente con datos completos desde el CRM (migración 0045) y lo que ocurre alrededor:
 *  - el formulario no deja guardar sin celular, correo ni fecha de nacimiento, y lo dice en su campo;
 *  - una fecha futura se rechaza aunque el navegador la deje escribir;
 *  - el cliente nuevo queda listo para su portal: se le crea su enlace de acceso de un solo uso;
 *  - un cliente histórico incompleto se ve marcado como "datos pendientes" y NO se duplica al completarlo;
 *  - cambiar el correo de quien ya tiene portal cierra su sesión y anula sus enlaces anteriores.
 *
 * Requiere el admin corriendo (E2E_BASE_URL) y DATABASE_URL apuntando a la MISMA base.
 */
import { expect, test, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 3 });

test.describe.configure({ mode: "serial" });
// La regla es la misma en móvil y escritorio y cada prueba escribe en la base: basta un proyecto.
test.skip(() => test.info().project.name !== "desktop", "basta un proyecto");

test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

/** El primer fill puede perderse durante la hidratación de React: reintenta hasta que el valor quede. */
async function fillField(page: Page, selector: string, value: string) {
  for (let i = 0; i < 5; i++) {
    await page.fill(selector, value);
    await page.waitForTimeout(200);
    if ((await page.inputValue(selector)) === value) return;
  }
  throw new Error(`No se pudo capturar ${selector}`);
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("form, main");
      return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
    },
    undefined,
    { timeout: 30_000 },
  );
}

async function login(page: Page) {
  await page.context().clearCookies();
  for (let i = 0; i < 4; i++) {
    await open(page, "/login?next=/clientes");
    await fillField(page, "#email", EMAIL);
    await fillField(page, "#password", PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error("No se pudo iniciar sesión");
}

const stamp = `${Date.now().toString().slice(-7)}`;

test("el alta exige celular, correo y fecha de nacimiento, y prepara el portal", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page);
  await open(page, "/clientes/nuevo");

  // Los tres campos están marcados como obligatorios en el formulario.
  for (const sel of ["#phone", "#email", "#birthday"])
    await expect(page.locator(sel)).toHaveAttribute("required", /.*/);
  // El navegador no deja ni siquiera elegir una fecha futura.
  await expect(page.locator("#birthday")).toHaveAttribute(
    "max",
    new Date().toISOString().slice(0, 10),
  );

  // Sin fecha de nacimiento el servidor lo rechaza (se quita `required` para llegar hasta él).
  const nombre = `E2E Completo ${stamp}`;
  await fillField(page, "#full_name", nombre);
  await fillField(page, "#phone", `668${stamp}`);
  await fillField(page, "#email", `completo-${stamp}@example.com`);
  await page.locator("#birthday").evaluate((el) => el.removeAttribute("required"));
  await page.getByRole("button", { name: "Registrar cliente" }).click();
  // `p[role=alert]` y no getByRole: Next añade su propio anunciador de ruta con role="alert".
  await expect(page.locator('p[role="alert"]')).toContainText(/fecha de nacimiento/i, {
    timeout: 20_000,
  });
  expect(
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from customers where full_name = ${nombre}`.execute(db)
    ).rows[0]!.n,
  ).toBe(0);

  // Con todo capturado, se crea y queda listo para entrar a su portal.
  await open(page, "/clientes/nuevo");
  await fillField(page, "#full_name", nombre);
  await fillField(page, "#phone", `668${stamp}`);
  await fillField(page, "#email", `completo-${stamp}@example.com`);
  await fillField(page, "#birthday", "1993-11-04");
  await page.getByRole("button", { name: "Registrar cliente" }).click();
  await page.waitForURL(/\/clientes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const id = new URL(page.url()).pathname.split("/")[2]!;
  await expect(page.getByRole("heading", { level: 1, name: nombre })).toBeVisible();
  // No hay aviso de datos pendientes: la ficha nació completa.
  await expect(page.getByText(/Datos pendientes/)).toHaveCount(0);

  const c = await sql<{ email: string; phone: string; birthday: string; tokens: number }>`
    select email::text as email, phone::text as phone, to_char(birthday,'YYYY-MM-DD') as birthday,
           (select count(*)::int from customer_access_tokens t where t.customer_id = c.id) as tokens
      from customers c where c.id = ${id}::uuid`.execute(db);
  expect(c.rows[0]).toMatchObject({
    email: `completo-${stamp}@example.com`,
    phone: `668${stamp}`,
    birthday: "1993-11-04",
  });

  /*
   * Portal del cliente nuevo. Con correo configurado (producción) el alta le manda su enlace de un
   * solo uso; sin proveedor de correo (esta prueba, y CI) el CRM lo dice y deja el botón para
   * entregarlo a mano. Lo que se comprueba es la INVARIANTE entre las dos ramas: hubo enlace si y
   * solo si se envió, y en cualquier caso el CRM ofrece la manera de dárselo.
   */
  const enviado = (await page.getByText(/Le enviamos por correo/).count()) > 0;
  if (!enviado) await expect(page.getByText(/mándale su enlace desde esta ficha/i)).toBeVisible();
  const audit = await sql<{ n: number }>`
    select count(*)::int as n from audit_logs
     where entity = 'customers' and entity_id = ${id} and action = 'CUSTOMER_ACCESS_LINK'`.execute(
    db,
  );
  expect(audit.rows[0]!.n).toBe(enviado ? 1 : 0);
  expect(c.rows[0]!.tokens).toBe(enviado ? 1 : 0);
  await expect(page.getByRole("button", { name: /enlace/i }).first()).toBeVisible();
});

test("cliente histórico: se marca lo pendiente, se completa sin duplicar y conserva su tarjeta", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const r = await sql<{ r: { customer_id: string } }>`
    select register_customer(${JSON.stringify({
      full_name: `E2E Historico ${stamp}`,
      phone: `669${stamp}`,
      allow_incomplete: true,
    })}::jsonb) as r`.execute(db);
  const id = r.rows[0]!.r.customer_id;
  const antes = await sql<{ public_code: string; qr_token: string }>`
    select public_code, qr_token from customers where id = ${id}::uuid`.execute(db);

  await login(page);
  await open(page, `/clientes/${id}`);
  await expect(page.getByText(/Datos pendientes:/)).toContainText("correo");
  await expect(page.getByText(/Datos pendientes:/)).toContainText("fecha de nacimiento");

  // En la edición esos campos NO son obligatorios (no se bloquea a quien ya existía)…
  await open(page, `/clientes/${id}/editar`);
  await expect(page.locator("#email")).not.toHaveAttribute("required", /.*/);
  await expect(page.locator("#birthday")).not.toHaveAttribute("required", /.*/);
  // …y al capturarlos se completa el MISMO registro.
  await fillField(page, "#email", `historico-${stamp}@example.com`);
  await fillField(page, "#birthday", "1980-02-29");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await page.waitForURL(new RegExp(`/clientes/${id}(\\?|$)`), { timeout: 20_000 });
  await expect(page.getByText(/Datos pendientes/)).toHaveCount(0);

  const despues = await sql<{
    public_code: string;
    qr_token: string;
    email: string;
    birthday: string;
    n: number;
  }>`select c.public_code, c.qr_token, c.email::text as email, to_char(c.birthday,'YYYY-MM-DD') as birthday,
            (select count(*)::int from customers x where x.phone = c.phone and x.deleted_at is null) as n
       from customers c where c.id = ${id}::uuid`.execute(db);
  expect(despues.rows[0]).toMatchObject({
    public_code: antes.rows[0]!.public_code,
    qr_token: antes.rows[0]!.qr_token,
    email: `historico-${stamp}@example.com`,
    birthday: "1980-02-29",
    n: 1, // no se creó un segundo cliente con el mismo teléfono
  });
});

test("cambiar el correo cierra la sesión del portal y anula los enlaces anteriores", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const r = await sql<{ r: { customer_id: string } }>`
    select register_customer(${JSON.stringify({
      full_name: `E2E Correo ${stamp}`,
      phone: `661${stamp}`,
      email: `correo-viejo-${stamp}@example.com`,
      birthday: "1995-05-05",
    })}::jsonb) as r`.execute(db);
  const id = r.rows[0]!.r.customer_id;
  // Enlace pendiente y sesión abierta, como si el cliente estuviera dentro de su portal.
  await sql`insert into customer_access_tokens(customer_id, token_hash, requested_by, expires_at)
            values (${id}::uuid, ${`hash-${stamp}`}, 'self', now() + interval '1 hour')`.execute(
    db,
  );
  await sql`insert into customer_sessions(customer_id, token_hash, expires_at)
            values (${id}::uuid, ${`sesion-${stamp}`}, now() + interval '30 days')`.execute(db);

  await login(page);
  await open(page, `/clientes/${id}/editar`);
  await fillField(page, "#email", `correo-nuevo-${stamp}@example.com`);
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await page.waitForURL(new RegExp(`/clientes/${id}(\\?|$)`), { timeout: 20_000 });
  await expect(page.getByText(/se cerró su sesión del portal/i)).toBeVisible();

  const estado = await sql<{ vivos: number; sesiones: number; email: string }>`
    select (select count(*)::int from customer_access_tokens
             where customer_id = ${id}::uuid and used_at is null and expires_at > now()) as vivos,
           (select count(*)::int from customer_sessions
             where customer_id = ${id}::uuid and revoked_at is null) as sesiones,
           (select email::text from customers where id = ${id}::uuid) as email`.execute(db);
  expect(estado.rows[0]).toEqual({
    vivos: 0,
    sesiones: 0,
    email: `correo-nuevo-${stamp}@example.com`,
  });
  // El historial del cliente sigue siendo el suyo: mismo registro, no uno nuevo.
  const n = await sql<{ n: number }>`
    select count(*)::int as n from customers where phone = ${`661${stamp}`} and deleted_at is null`.execute(
    db,
  );
  expect(n.rows[0]!.n).toBe(1);
});
