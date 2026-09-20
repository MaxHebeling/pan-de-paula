import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

/**
 * Referencia contable del pago, de punta a punta en el CRM:
 * cobrar en el POS con referencia → verla en Ventas, en el pedido, en el corte y en el reporte →
 * corregirla desde el pedido → encontrarla con el buscador → exportar el CSV con la columna.
 *
 * Solo en el proyecto "desktop": la caja es un singleton y dos proyectos en paralelo se pisan.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026",
};
const REF = `E2E-REF-${Date.now().toString().slice(-8)}`;
const REF_FIXED = `${REF}-OK`;

const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 3 });

test.describe.configure({ mode: "serial" });
test.skip(() => test.info().project.name !== "desktop", "la caja es singleton: solo desktop");
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

async function fillField(page: Page, label: string | RegExp, value: string) {
  const field = page.getByLabel(label, { exact: typeof label === "string" });
  for (let i = 0; i < 5; i++) {
    await field.fill(value);
    await page.waitForTimeout(120);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${String(label)}"`);
}

async function login(page: Page) {
  await page.goto("/login?next=%2Fdashboard");
  await page.waitForLoadState("domcontentloaded");
  for (let attempt = 0; attempt < 4; attempt++) {
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

async function apiHeaders(page: Page) {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "pdp_session");
  expect(session, "cookie de sesión").toBeTruthy();
  return { Cookie: `pdp_session=${session!.value}` };
}

async function typeOnNumpad(page: Page, cents: number) {
  await page.getByRole("button", { name: "Borrar todo" }).first().click();
  for (const d of String(cents)) await page.getByRole("button", { name: d, exact: true }).click();
}

/** Deja una caja abierta (si otra corrida la dejó abierta, se reutiliza) y devuelve su id. */
async function ensureRegisterOpen(page: Page) {
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await typeOnNumpad(page, 50000);
    await page.getByTestId("open-register").click();
    await Promise.race([
      page.getByText("Caja abierta. Ya puedes cobrar en efectivo.").waitFor(),
      page.getByRole("alert").filter({ hasText: "Ya hay una caja abierta" }).waitFor(),
    ]);
  }
  const r = await sql<{
    id: string;
  }>`select id from register_sessions where status = 'open' limit 1`.execute(db);
  expect(r.rows[0], "caja abierta").toBeTruthy();
  return r.rows[0]!.id;
}

let folio = "";
let sessionId = "";
let orderId = "";

test("cobrar con referencia en el POS y verla en todo el CRM", async ({ page }) => {
  await login(page);
  sessionId = await ensureRegisterOpen(page);

  // ── Cobro por transferencia con referencia contable ───────────────────────
  await page.goto("/pos");
  await expect(page.getByRole("heading", { name: "Punto de venta" })).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await page.getByRole("button", { name: "Agregar Croissant de mantequilla" }).click();
  const checkout = page.getByTestId("checkout-button");
  if (!(await checkout.isVisible())) await page.getByTestId("open-cart").click();
  await checkout.click();
  await expect(page.getByTestId("checkout-modal")).toBeVisible();
  await page.getByTestId("pay-tab-transfer").click();
  await page.locator("#pay-reference").fill(REF);
  await page.getByTestId("confirm-payment").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  folio = (await page.getByTestId("sale-folio").innerText()).trim();
  expect(folio).toMatch(/^PDP-\d{4}-\d{6}$/);

  const saved = await sql<{ order_id: string; reference: string }>`
    select p.order_id, p.reference from payments p join orders o on o.id = p.order_id where o.folio = ${folio}`.execute(
    db,
  );
  expect(saved.rows[0]!.reference).toBe(REF); // se guardó tal cual se escribió
  orderId = saved.rows[0]!.order_id;

  // ── Ventas del POS: se busca por la referencia y se ve junto a su método ──
  await page.goto(`/pos/ventas?q=${encodeURIComponent(REF)}`);
  await expect(page.getByText(folio)).toBeVisible();
  await page.getByTestId("sale-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("payment-reference").first()).toHaveText(REF);

  // Filtrar por un método que no se usó deja la lista vacía
  await page.goto(`/pos/ventas?q=${encodeURIComponent(REF)}&metodo=cash`);
  await expect(page.getByText("No hay ventas para mostrar.")).toBeVisible();

  // ── Detalle del pedido: la referencia y el corte del turno ───────────────
  await page.goto(`/pedidos/${orderId}`);
  await expect(page.getByTestId("payment-reference").first()).toHaveText(REF);

  await page.goto(`/corte/${sessionId}`);
  await expect(page.getByTestId("corte-movimientos")).toContainText(REF);
  await expect(page.getByTestId("corte-movimientos")).toContainText(folio);

  // ── Buscador global: pegar la referencia lleva al pedido ─────────────────
  await page.goto(`/buscar?q=${encodeURIComponent(REF)}`);
  await expect(page.getByTestId("search-payment-reference").first()).toContainText(REF);
  await expect(page.getByRole("link", { name: folio })).toBeVisible();

  // ── Corregir la referencia desde el pedido (queda en auditoría) ──────────
  await page.goto(`/pedidos/${orderId}`);
  await page.getByTestId("edit-reference").first().locator("summary").click();
  const input = page.locator('input[name="reference"]').first();
  await input.fill(REF_FIXED);
  await page.getByRole("button", { name: "Guardar" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: REF_FIXED })).toBeVisible();
  const audited = await sql<{ old_ref: string; new_ref: string }>`
    select a.old_data->>'reference' as old_ref, a.new_data->>'reference' as new_ref
    from audit_logs a where a.entity = 'payments' and a.action = 'UPDATE'
      and a.new_data->>'reference' = ${REF_FIXED} order by a.id desc limit 1`.execute(db);
  expect(audited.rows[0]).toEqual({ old_ref: REF, new_ref: REF_FIXED });

  // ── Reporte de pagos y exportación con la columna "Referencia" ───────────
  const hoy = (
    await sql<{
      d: string;
    }>`select (now() at time zone (select timezone from business_settings where id=1))::date::text as d`.execute(
      db,
    )
  ).rows[0]!.d;
  await page.goto(`/reportes/pagos?from=${hoy}&to=${hoy}&ref=${encodeURIComponent(REF_FIXED)}`);
  await expect(page.getByTestId("payments-report")).toContainText(REF_FIXED);

  const csv = await (page.request as APIRequestContext).get(
    `/api/reports/export?report=pagos&from=${hoy}&to=${hoy}&format=csv&ref=${encodeURIComponent(REF_FIXED)}`,
    { headers: await apiHeaders(page) },
  );
  expect(csv.ok()).toBeTruthy();
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text.split("\n")[0]).toContain("Referencia");
  expect(text).toContain(REF_FIXED);
  expect(text).toContain(folio);

  // ── Dashboard: los cobros del día muestran método + referencia ───────────
  await page.goto("/dashboard");
  await expect(page.getByTestId("cobros-hoy")).toContainText(REF_FIXED);
});
