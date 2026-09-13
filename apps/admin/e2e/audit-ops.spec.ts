import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createDb, sql } from "@pdp/db";

/**
 * Auditoría OPERACIÓN (POS, caja, pedidos, producción, inventario, notificaciones).
 * Corre contra un servidor levantado (E2E_BASE_URL) sobre una base con seed + usuarios de auditoría
 * (cajera@audit.local rol cashier, produccion@audit.local rol production). Verifica cada acción por SQL.
 * Solo en el proyecto "desktop": la caja y el conteo son singletons y dos proyectos se pisarían.
 */
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local",
  password: process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026",
};
const CASHIER = { email: "cajera@audit.local", password: "AuditOps!2026x" };
const PRODUCTION = { email: "produccion@audit.local", password: "AuditOps!2026x" };
const CRON_SECRET = process.env.CRON_SECRET ?? "dev-cron-secret";

const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 3 });
type Row = Record<string, unknown>;
const rows = async <T extends Row = Row>(q: ReturnType<typeof sql<T>>) =>
  (await q.execute(db)).rows;
const one = async <T extends Row = Row>(q: ReturnType<typeof sql<T>>) => (await rows<T>(q))[0]!;
const num = (s: string | null | undefined) => Number((s ?? "0").replace(/[^0-9.-]/g, ""));

test.describe.configure({ mode: "serial" });
test.skip(() => test.info().project.name !== "desktop", "singletons: solo desktop");
test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

// ── Helpers ─────────────────────────────────────────────────────────────────
async function fillField(page: Page, label: string | RegExp, value: string) {
  const field = page.getByLabel(label, { exact: typeof label === "string" });
  for (let i = 0; i < 5; i++) {
    await field.fill(value);
    await page.waitForTimeout(120);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${String(label)}"`);
}

async function login(page: Page, user = ADMIN, next = "/dashboard") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.waitForLoadState("domcontentloaded");
  for (let attempt = 0; attempt < 4; attempt++) {
    await fillField(page, "Correo", user.email);
    await fillField(page, "Contraseña", user.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error(`No se pudo iniciar sesión como ${user.email}`);
}

async function typeOnNumpad(page: Page, cents: number) {
  await page.getByRole("button", { name: "Borrar todo" }).first().click();
  for (const d of String(cents)) await page.getByRole("button", { name: d, exact: true }).click();
}

/** Producto de auditoría con stock fijo (idempotente entre corridas). */
async function ensureProduct(name: string, slug: string, priceCents: number, stock: number) {
  const cat = await one<{ id: string }>(sql`select id from categories order by sort_order limit 1`);
  const p = await one<{ id: string }>(sql`
    insert into products(name, slug, category_id, track_stock, show_on_pos, show_on_web, is_active)
    values (${name}, ${slug}, ${cat.id}::uuid, true, true, true, true)
    on conflict (slug) do update set name = excluded.name, is_active = true, show_on_pos = true, deleted_at = null
    returning id`);
  await sql`delete from product_prices where product_id = ${p.id}::uuid`.execute(db);
  await sql`insert into product_prices(product_id, channel, kind, price_cents) values (${p.id}::uuid, 'all', 'regular', ${priceCents})`.execute(
    db,
  );
  const staff = await one<{ id: string }>(
    sql`select id from staff_users where email = ${ADMIN.email}`,
  );
  const cur = await one<{ on_hand: string }>(
    sql`select coalesce((select on_hand from inventory_levels where product_id = ${p.id}::uuid), 0)::text as on_hand`,
  );
  const delta = stock - Number(cur.on_hand);
  if (delta !== 0) {
    await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.staff_id', ${staff.id}, true)`.execute(trx);
      await sql`select record_stock_correction(${p.id}::uuid, ${delta}::numeric, 'other', 'audit e2e')`.execute(
        trx,
      );
    });
  }
  return p.id;
}

async function onHand(productId: string) {
  const r = await one<{ on_hand: string }>(
    sql`select coalesce((select on_hand from inventory_levels where product_id = ${productId}::uuid), 0)::text as on_hand`,
  );
  return Number(r.on_hand);
}

async function setFlag(key: string, enabled: boolean) {
  await sql`update feature_flags set enabled = ${enabled} where key = ${key}`.execute(db);
}

async function openRegisterIfClosed(page: Page, cents = 50000) {
  await page.goto("/caja");
  if (await page.getByTestId("register-open-form").isVisible()) {
    await typeOnNumpad(page, cents);
    await page.getByTestId("open-register").click();
    await page.waitForURL(/\/caja\?abierta=1/);
  }
  await expect(page.getByTestId("register-close-form")).toBeVisible();
}

async function closeRegisterIfOpen(page: Page) {
  await page.goto("/caja");
  if (await page.getByTestId("register-close-form").isVisible()) {
    await page.getByRole("button", { name: /Usar el esperado/ }).click();
    await page.getByLabel(/Confirmo el conteo/).check();
    await page.getByTestId("close-register").click();
    await page.waitForURL(/\/caja\/[0-9a-f-]+/);
  }
}

async function addToCart(page: Page, productName: string, times = 1) {
  await page.getByLabel("Buscar producto").fill(productName);
  const btn = page.getByRole("button", { name: `Agregar ${productName}`, exact: true });
  for (let i = 0; i < times; i++) await btn.click();
  await page.getByLabel("Buscar producto").fill("");
}

async function apiLogin(request: APIRequestContext, page: Page) {
  // Reutiliza la cookie de la página para las llamadas HTTP directas.
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "pdp_session");
  expect(session, "cookie de sesión").toBeTruthy();
  return { Cookie: `pdp_session=${session!.value}` };
}

/** Abre el <details> de devolución solo si está cerrado (tras un refresh conserva su estado). */
async function openReturnForm(page: Page) {
  if (!(await page.locator("#ret-qty").isVisible()))
    await page.getByText("Registrar devolución física").click();
  await expect(page.locator("#ret-qty")).toBeVisible();
}

const PAN = "Audit Pan E2E";
const ULTIMO = "Audit Último E2E";
let panId: string;
let ultimoId: string;

test.beforeAll(async () => {
  panId = await ensureProduct(PAN, "audit-pan-e2e", 4000, 100);
  ultimoId = await ensureProduct(ULTIMO, "audit-ultimo-e2e", 3000, 1);
  await sql`update business_settings set allow_negative_stock = true`.execute(db);
  await setFlag("pos_offline_queue", false);
  await setFlag("mercadopago_point", false);
  await setFlag("mercadopago_qr", false);
});

// ── 1. Permisos por rol ─────────────────────────────────────────────────────
test("permisos: cajera sin descuentos ni anulaciones; producción sin POS ni caja", async ({
  page,
  request,
}) => {
  await login(page, CASHIER, "/pos");
  await expect(page.getByRole("heading", { name: "Punto de venta" })).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await addToCart(page, PAN);
  await expect(page.getByTestId("cart-line")).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Descuento para ${PAN}` })).toHaveCount(0);
  // Descuento por línea por HTTP directo → 403
  const headers = await apiLogin(page.request, page);
  const r = await page.request.post("/api/pos/checkout", {
    headers,
    data: {
      idempotency_key: `aud-disc-${Date.now()}`,
      items: [{ product_id: panId, qty: 1, discount_cents: 100 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 3900 }],
    },
  });
  expect(r.status()).toBe(403);
  expect((await r.json()).code).toBe("DISCOUNT_FORBIDDEN");
  // Ventas: sin botones de anular/reembolsar
  await page.goto("/pos/ventas");
  await expect(page.getByRole("heading", { name: "Ventas", exact: true })).toBeVisible();
  const first = page.getByTestId("sale-row").first();
  if (await first.isVisible()) {
    await first.getByRole("button").first().click();
    await expect(page.getByRole("button", { name: "Anular venta" })).toHaveCount(0);
  }
  // Inventario solo lectura, producción prohibida, caja permitida (pos.register)
  await page.goto("/inventario?tab=stock");
  await expect(page.getByRole("heading", { name: "Inventario", exact: true })).toBeVisible();
  await expect(page.getByText("Ajustar", { exact: true })).toHaveCount(0);
  await page.goto("/produccion");
  await expect(page).toHaveURL(/\/403/);
  await page.goto("/caja");
  await expect(page.getByRole("heading", { name: "Caja", exact: true })).toBeVisible();
  await page.request.post("/api/auth/logout", { headers }).catch(() => {});
  await page.context().clearCookies();

  await login(page, PRODUCTION, "/produccion");
  await expect(page.getByRole("heading", { name: "Producción", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Registrar 1 de ${PAN}` })).toBeEnabled();
  await page.goto("/pos");
  await expect(page).toHaveURL(/\/403/);
  await page.goto("/caja");
  await expect(page).toHaveURL(/\/403/);
  await page.goto("/inventario?tab=stock");
  await expect(page.getByText("Ajustar", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconstruir niveles" })).toHaveCount(0);
  const checkout = await page.request.post("/api/pos/checkout", {
    headers: await apiLogin(page.request, page),
    data: {
      idempotency_key: `aud-prod-${Date.now()}`,
      items: [{ product_id: panId, qty: 1 }],
      payments: [{ provider: "manual", method: "card_terminal", amount_cents: 4000 }],
    },
  });
  expect(checkout.status()).toBe(403);
  const anon = await request.get("/api/notifications/unread-count", { maxRedirects: 0 });
  expect([302, 307, 401]).toContain(anon.status());
});

// ── 2. POS sin caja abierta ─────────────────────────────────────────────────
test("POS con caja cerrada: efectivo bloqueado en UI y API; tarjeta/transferencia permitidas", async ({
  page,
}) => {
  await login(page);
  await closeRegisterIfOpen(page);
  await page.goto("/pos");
  await expect(page.getByTestId("register-closed")).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await addToCart(page, PAN);
  await page.getByTestId("checkout-button").click();
  await expect(page.getByTestId("pay-tab-cash")).toBeDisabled();
  await expect(
    page.getByText("La caja está cerrada: no se puede cobrar en efectivo."),
  ).toBeVisible();
  const headers = await apiLogin(page.request, page);
  const cash = await page.request.post("/api/pos/checkout", {
    headers,
    data: {
      idempotency_key: `aud-cash-closed-${Date.now()}`,
      items: [{ product_id: panId, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4000, tendered_cents: 5000 }],
    },
  });
  expect(cash.status()).toBe(409);
  expect((await cash.json()).code).toBe("REGISTER_CLOSED");
  // Transferencia con referencia sí procede y queda sin sesión de caja
  const before = await onHand(panId);
  await page.getByTestId("pay-tab-transfer").click();
  await page.getByLabel(/Referencia/).fill("SPEI-AUD-001");
  await page.getByTestId("confirm-payment").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  const folio = (await page.getByTestId("sale-folio").innerText()).trim();
  const sale = await one<{
    register_session_id: string | null;
    method: string;
    reference: string;
    status: string;
  }>(sql`select s.register_session_id, p.method::text as method, p.reference, o.status::text as status
         from orders o join sales s on s.order_id = o.id join payments p on p.order_id = o.id where o.folio = ${folio}`);
  expect(sale).toEqual({
    register_session_id: null,
    method: "transfer",
    reference: "SPEI-AUD-001",
    status: "completed",
  });
  expect(await onHand(panId)).toBe(before - 1);
  await page.getByTestId("new-sale").click();
});

// ── 3. Caja: abrir, vender dividido, anular, reembolsar, cerrar con diferencia ──
test("caja + POS: pago dividido igual, cliente por teléfono, cupón, anulación, reembolso y cierre con diferencia", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page);
  await openRegisterIfClosed(page, 50000);
  const session = await one<{ id: string }>(
    sql`select id from register_sessions where status = 'open'`,
  );
  // Un segundo intento de apertura (misma UI en otra pestaña) se rechaza por SQL
  const page2 = await page.context().newPage();
  await page2.goto("/caja");
  await expect(page2.getByTestId("register-open-form")).toHaveCount(0);
  await page2.close();

  // POS: cliente por teléfono + cupón válido + pago dividido con dos tarjetas iguales
  const customer = await one<{
    id: string;
    phone: string;
    full_name: string;
    points_balance: number;
  }>(
    sql`select id, phone::text as phone, full_name, points_balance from customers where deleted_at is null and merged_into_id is null and phone is not null order by created_at limit 1`,
  );
  await sql`insert into coupons(code, name, kind, value_bps, max_uses_per_customer) values ('AUDIT10', 'Audit 10%', 'pct', 1000, 99)
            on conflict (code) do update set is_active = true, max_uses = null, ends_at = null`.execute(
    db,
  );
  await page.goto("/pos");
  await expect(page.getByText("Caja abierta", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Todos" }).click();
  await addToCart(page, PAN, 2); // $80.00
  await page.getByLabel("Buscar cliente").fill(customer.phone);
  await page.getByLabel("Buscar cliente").press("Enter");
  await expect(page.getByTestId("pos-customer")).toContainText(customer.full_name);
  // Cupón inválido primero
  await page.getByLabel("Código de cupón").fill("NOEXISTE");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Cupón no encontrado" })).toBeVisible();
  await page.getByLabel("Código de cupón").fill("AUDIT10");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page.getByText(/Cupón AUDIT10/)).toBeVisible();
  await expect(page.getByTestId("cart-total")).toHaveText("$72.00");
  await page.getByTestId("checkout-button").click();
  await page.getByTestId("pay-tab-split").click();
  await page.getByRole("button", { name: "Tarjeta (terminal)" }).click();
  await typeOnNumpad(page, 3600);
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await page.getByRole("button", { name: /Resto exacto/ }).click();
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await page.getByRole("button", { name: /Cobrar \$72\.00 en 2 pagos/ }).click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  const folio = (await page.getByTestId("sale-folio").innerText()).trim();
  await expect(page.getByTestId("sale-success")).toContainText("+7"); // $72 → 7.2 → floor = 7 puntos
  const o = await one<{
    status: string;
    paid_cents: number;
    discount_cents: number;
    coupon_code: string;
    pays: number;
    sale_id: string | null;
    customer_id: string;
  }>(sql`select o.status::text as status, o.paid_cents, o.discount_cents, o.coupon_code, o.customer_id,
           (select count(*)::int from payments p where p.order_id = o.id and p.status = 'paid') as pays,
           (select id from sales s where s.order_id = o.id) as sale_id
         from orders o where o.folio = ${folio}`);
  expect(o.status).toBe("completed");
  expect(o.paid_cents).toBe(7200);
  expect(o.discount_cents).toBe(800);
  expect(o.coupon_code).toBe("AUDIT10");
  expect(o.pays).toBe(2);
  expect(o.sale_id).toBeTruthy();
  expect(o.customer_id).toBe(customer.id);
  await page.getByTestId("new-sale").click();

  // Segunda venta en efectivo con cambio para poder anular
  await addToCart(page, PAN);
  await page.getByTestId("checkout-button").click();
  await page.getByTestId("quick-5000").click();
  await expect(page.getByTestId("change")).toHaveText("$10.00");
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  await expect(page.getByTestId("sale-change")).toHaveText("$10.00");
  const folioCash = (await page.getByTestId("sale-folio").innerText()).trim();
  // Recibo: imprimible y WhatsApp
  const headers = await apiLogin(page.request, page);
  const orderId = (await one<{ id: string }>(sql`select id from orders where folio = ${folioCash}`))
    .id;
  const receipt = await page.request.get(`/recibo/${orderId}`, { headers });
  expect(receipt.ok()).toBeTruthy();
  expect(await receipt.text()).toContain(folioCash);
  const wa = await page.request.post("/api/pos/receipt", {
    headers,
    data: { orderId, channel: "whatsapp", destination: "6641234567" },
  });
  expect(wa.ok()).toBeTruthy();
  expect((await wa.json()).url).toMatch(/^https:\/\/wa\.me\/526641234567\?text=/);
  const badWa = await page.request.post("/api/pos/receipt", {
    headers,
    data: { orderId, channel: "whatsapp", destination: "123" },
  });
  expect(badWa.status()).toBe(400);
  const receipts = await one<{ n: number }>(
    sql`select count(*)::int as n from receipts where order_id = ${orderId}::uuid and channel = 'whatsapp' and status = 'sent'`,
  );
  expect(receipts.n).toBe(1);
  await page.getByTestId("new-sale").click();

  // Resumen en vivo de caja
  await page.goto("/caja");
  const expected = Number(await page.getByTestId("expected-cash").getAttribute("data-cents"));
  expect(expected).toBe(50000 + 4000);
  await expect(page.getByTestId("register-summary")).toContainText("Tarjeta (terminal)");

  // Anular la venta en efectivo desde Ventas del día
  const stockBefore = await onHand(panId);
  await page.goto(`/pos/ventas?q=${folioCash}`);
  const row = page.getByTestId("sale-row").filter({ hasText: folioCash });
  await row.getByRole("button").first().click();
  await page.getByRole("button", { name: "Anular venta" }).click();
  await page.getByPlaceholder("Motivo (obligatorio)").fill("auditoría e2e");
  await page.getByLabel(/Confirmo que deseo anular/).check();
  await page.getByRole("button", { name: "Anular venta" }).last().click();
  await expect(page.getByRole("status").filter({ hasText: "Venta anulada" })).toBeVisible();
  expect(await onHand(panId)).toBe(stockBefore + 1);
  const voided = await one<{
    voided_at: Date | null;
    status: string;
    payment_status: string;
    void_mv: number;
  }>(sql`select s.voided_at, o.status::text as status, o.payment_status::text as payment_status,
           (select count(*)::int from inventory_movements m where m.ref_type = 'sale' and m.ref_id = s.id::text and m.type = 'VOID') as void_mv
         from sales s join orders o on o.id = s.order_id where o.folio = ${folioCash}`);
  expect(voided.voided_at).toBeTruthy();
  expect(voided.status).toBe("cancelled");
  expect(voided.payment_status).toBe("cancelled");
  expect(voided.void_mv).toBe(1);
  // La caja ya no espera ese efectivo
  await page.goto("/caja");
  expect(Number(await page.getByTestId("expected-cash").getAttribute("data-cents"))).toBe(50000);

  // Reembolso parcial de la venta con tarjeta (no regresa stock, revierte puntos proporcionales)
  const pointsBefore = (
    await one<{ points_balance: number }>(
      sql`select points_balance from customers where id = ${customer.id}::uuid`,
    )
  ).points_balance;
  const stockBeforeRefund = await onHand(panId);
  await page.goto(`/pos/ventas?q=${folio}`);
  const row2 = page.getByTestId("sale-row").filter({ hasText: folio });
  await row2.getByRole("button").first().click();
  await page.getByRole("button", { name: "Reembolso parcial" }).click();
  await page.getByLabel("Monto $").fill("18");
  await page.getByPlaceholder("Motivo (obligatorio)").fill("producto en mal estado");
  await page.getByLabel(/Confirmo el reembolso/).check();
  await page.getByRole("button", { name: "Registrar reembolso" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Reembolso registrado" })).toBeVisible();
  expect(await onHand(panId)).toBe(stockBeforeRefund);
  const refund = await one<{
    amount_cents: number;
    payment_status: string;
    refunded_cents: number;
  }>(
    sql`select r.amount_cents, o.payment_status::text as payment_status, o.refunded_cents from refunds r join orders o on o.id = r.order_id where o.folio = ${folio}`,
  );
  expect(refund).toEqual({
    amount_cents: 1800,
    payment_status: "partially_refunded",
    refunded_cents: 1800,
  });
  const pointsAfter = (
    await one<{ points_balance: number }>(
      sql`select points_balance from customers where id = ${customer.id}::uuid`,
    )
  ).points_balance;
  expect(pointsBefore - pointsAfter).toBe(Math.floor(7 * (1800 / 7200))); // 7 puntos × 25 %
  await page.reload();
  await expect(page.getByTestId("sale-row").filter({ hasText: folio })).toContainText(
    "Reembolso parcial",
  );

  // Segunda venta en efectivo exacta ($40) que se anulará DESPUÉS del cierre
  await page.goto("/pos");
  await addToCart(page, PAN);
  await page.getByTestId("checkout-button").click();
  await page.getByTestId("quick-4000").click();
  await page.getByRole("button", { name: "Cobrar", exact: true }).click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  const folioLate = (await page.getByTestId("sale-folio").innerText()).trim();
  await page.getByTestId("new-sale").click();

  // Cierre con diferencia: esperado $540, contado $530 (falta $10) → notificación
  await page.goto("/caja");
  expect(Number(await page.getByTestId("expected-cash").getAttribute("data-cents"))).toBe(54000);
  await typeOnNumpad(page, 53000);
  await expect(page.getByTestId("difference")).toHaveText("−$10.00");
  await page.getByLabel(/Confirmo el conteo/).check();
  await page.getByTestId("close-register").click();
  await page.waitForURL(/\/caja\/[0-9a-f-]+\?cerrada=1/);
  await expect(page.getByText("Diferencia registrada")).toBeVisible();
  await expect(page.getByTestId("summary-difference")).toHaveText("−$10.00");
  const closed = await one<{
    status: string;
    expected_cash_cents: number;
    counted_cash_cents: number;
    difference_cents: number;
    notif: number;
  }>(sql`select status, expected_cash_cents, counted_cash_cents, difference_cents,
           (select count(*)::int from notifications n where n.kind = 'register_difference' and n.entity_id = rs.id::text) as notif
         from register_sessions rs where id = ${session.id}::uuid`);
  expect(closed).toEqual({
    status: "closed",
    expected_cash_cents: 54000,
    counted_cash_cents: 53000,
    difference_cents: -1000,
    notif: 1,
  });
  // Corte imprimible e historial
  const corte = await page.request.get(`/corte/${session.id}`, { headers });
  expect(corte.ok()).toBeTruthy();
  expect(await corte.text()).toContain("CORTE DE CAJA");
  // Anular una venta en efectivo DESPUÉS del corte no reescribe el corte: esperado congelado ($540) y diferencia coherente
  await page.goto(`/pos/ventas?q=${folioLate}`);
  const rowLate = page.getByTestId("sale-row").filter({ hasText: folioLate });
  await rowLate.getByRole("button").first().click();
  await page.getByRole("button", { name: "Anular venta" }).click();
  await page.getByPlaceholder("Motivo (obligatorio)").fill("anulada tras el corte");
  await page.getByLabel(/Confirmo que deseo anular/).check();
  await page.getByRole("button", { name: "Anular venta" }).last().click();
  await expect(page.getByRole("status").filter({ hasText: "Venta anulada" })).toBeVisible();
  await page.goto(`/caja/${session.id}`);
  const summaryRows = page.getByTestId("register-summary").getByRole("row");
  await expect(summaryRows.filter({ hasText: "Efectivo esperado" })).toContainText("$540.00");
  await expect(summaryRows.filter({ hasText: "Efectivo contado" })).toContainText("$530.00");
  await expect(page.getByTestId("summary-difference")).toHaveText("−$10.00");
  await expect(summaryRows.filter({ hasText: /Ventas \(/ })).toContainText("2 anuladas");
  await page.goto("/caja");
  await expect(page.getByTestId("register-open-form")).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: /[-−]\$10\.00/ })
      .first(),
  ).toBeVisible();
  // Vender en efectivo tras el cierre vuelve a estar bloqueado
  await page.goto("/pos");
  await expect(page.getByTestId("register-closed")).toBeVisible();
});

// ── 4. Idempotencia, alta rápida, QR, recompensa y atajos ────────────────────
test("POS: doble envío = una venta; alta rápida deduplica; QR por token; recompensa; atajos F2/F9/Esc", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN, "/pos");
  const headers = await apiLogin(page.request, page);
  const key = `aud-idem-${Date.now()}`;
  const body = {
    idempotency_key: key,
    items: [{ product_id: panId, qty: 1 }],
    payments: [{ provider: "manual", method: "card_terminal", amount_cents: 4000 }],
  };
  const before = await onHand(panId);
  const [a, b] = await Promise.all([
    page.request.post("/api/pos/checkout", { headers, data: body }),
    page.request.post("/api/pos/checkout", { headers, data: body }),
  ]);
  const ja = await a.json();
  const jb = await b.json();
  expect([a.status(), b.status()].sort()).toEqual([200, 201]);
  expect(ja.orderId).toBe(jb.orderId);
  expect([ja.duplicate, jb.duplicate].filter(Boolean).length).toBe(1);
  const n = await one<{ n: number }>(
    sql`select count(*)::int as n from sales s join orders o on o.id = s.order_id where o.idempotency_key = ${key}`,
  );
  expect(n.n).toBe(1);
  expect(await onHand(panId)).toBe(before - 1);

  // Alta rápida: crea y deduplica por teléfono
  const phone = `664${String(Date.now()).slice(-7)}`;
  const c1 = await page.request.post("/api/pos/customers", {
    headers,
    data: { full_name: "Cliente Audit Nuevo", phone },
  });
  expect(c1.status()).toBe(201);
  const c2 = await page.request.post("/api/pos/customers", {
    headers,
    data: { full_name: "Cliente Audit Nuevo", phone },
  });
  expect(c2.status()).toBe(200);
  expect((await c2.json()).created).toBe(false);
  const created = await one<{ id: string; qr_token: string; public_code: string }>(
    sql`select id, qr_token, public_code from customers where phone = ${phone}`,
  );
  // Lectura de QR (token opaco) y código público → cliente exacto
  for (const q of [created.qr_token, created.public_code]) {
    const r = await page.request.get(`/api/pos/customers?q=${encodeURIComponent(q)}`, { headers });
    const j = await r.json();
    expect(j.customers).toHaveLength(1);
    expect(j.customers[0].id).toBe(created.id);
  }
  const bad = await page.request.post("/api/pos/customers", {
    headers,
    data: { full_name: "X", phone: "12" },
  });
  expect(bad.status()).toBe(400);

  // Recompensa: cliente con puntos suficientes canjea "Descuento de $20" y la aplica en la venta
  const reward = await one<{ id: string; points_cost: number; value_cents: number }>(
    sql`select id, points_cost, value_cents from rewards where kind = 'discount_amount' and is_active limit 1`,
  );
  await sql`update customers set points_balance = greatest(points_balance, ${reward.points_cost + 10}) where id = ${created.id}::uuid`.execute(
    db,
  );
  const balBefore = (
    await one<{ points_balance: number }>(
      sql`select points_balance from customers where id = ${created.id}::uuid`,
    )
  ).points_balance;
  await page.goto("/pos");
  await page.getByRole("tab", { name: "Todos" }).click();
  await addToCart(page, PAN);
  await page.getByLabel("Buscar cliente").fill(created.qr_token);
  await page.getByLabel("Buscar cliente").press("Enter");
  await expect(page.getByTestId("pos-customer")).toContainText("Cliente Audit Nuevo");
  await page.getByRole("button", { name: /Recompensas/ }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /Descuento de \$20/ }).click();
  await expect(page.getByText(/Recompensa emitida/)).toBeVisible();
  await expect(page.getByTestId("cart-total")).toHaveText("$20.00");
  // Atajos: Esc no cierra nada raro, F9 abre cobro, Esc lo cierra, F2 enfoca búsqueda
  await page.keyboard.press("F9");
  await expect(page.getByTestId("checkout-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("checkout-modal")).toHaveCount(0);
  await page.keyboard.press("F2");
  await expect(page.getByLabel("Buscar producto")).toBeFocused();
  await page.keyboard.press("F9");
  await page.getByTestId("pay-tab-card_terminal").click();
  await page.getByTestId("confirm-payment").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  const folio = (await page.getByTestId("sale-folio").innerText()).trim();
  const rewardRow = await one<{
    discount_cents: number;
    total_cents: number;
    redemption_status: string;
    balance: number;
  }>(sql`select o.discount_cents, o.total_cents, rr.status as redemption_status, c.points_balance as balance
         from orders o join reward_redemptions rr on rr.id = o.reward_redemption_id join customers c on c.id = o.customer_id
         where o.folio = ${folio}`);
  expect(rewardRow.discount_cents).toBe(reward.value_cents);
  expect(rewardRow.total_cents).toBe(4000 - reward.value_cents);
  expect(rewardRow.redemption_status).toBe("applied");
  // Puntos: −costo del canje +ganados por $20 (2)
  expect(rewardRow.balance).toBe(balBefore - reward.points_cost + 2);
  // Enter en la pantalla de éxito inicia nueva venta
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sale-success")).toHaveCount(0);
  await expect(page.getByTestId("cart-line")).toHaveCount(0);
});

// ── 5. Mercado Pago sin credenciales ────────────────────────────────────────
test("Mercado Pago Point/QR: flag apagado → 409; encendido sin credenciales → 503 sin pedidos huérfanos", async ({
  page,
}) => {
  await login(page, ADMIN, "/pos");
  const headers = await apiLogin(page.request, page);
  const count = async () =>
    (await one<{ n: number }>(sql`select count(*)::int as n from orders`)).n;
  const body = (kind: string) => ({
    idempotency_key: `aud-mp-${kind}-${Date.now()}`,
    items: [{ product_id: panId, qty: 1 }],
    kind,
  });
  await expect(page.getByTestId("pay-tab-mp_point")).toHaveCount(0);
  const before = await count();
  for (const kind of ["point", "qr"]) {
    const r = await page.request.post("/api/pos/payments/mercadopago", {
      headers,
      data: body(kind),
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe("FLAG_OFF");
  }
  await setFlag("mercadopago_point", true);
  await setFlag("mercadopago_qr", true);
  try {
    for (const kind of ["point", "qr"]) {
      const r = await page.request.post("/api/pos/payments/mercadopago", {
        headers,
        data: body(kind),
      });
      expect(r.status()).toBe(503);
      const j = await r.json();
      expect(j.code).toBe("MP_NOT_CONFIGURED");
      expect(j.error).toMatch(/Mercado Pago no está configurado/);
    }
    expect(await count()).toBe(before);
    // El checkout normal rechaza pagos MP
    const direct = await page.request.post("/api/pos/checkout", {
      headers,
      data: {
        idempotency_key: `aud-mp-direct-${Date.now()}`,
        items: [{ product_id: panId, qty: 1 }],
        payments: [{ provider: "mercadopago", method: "mercadopago", amount_cents: 4000 }],
      },
    });
    expect(direct.status()).toBe(400);
    expect((await direct.json()).code).toBe("MP_NOT_HERE");
    // UI: la pestaña aparece y muestra un mensaje claro sin dejar pedido
    await page.goto("/pos");
    await page.getByRole("tab", { name: "Todos" }).click();
    await addToCart(page, PAN);
    await page.getByTestId("checkout-button").click();
    await page.getByTestId("pay-tab-mp_point").click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Mercado Pago no está configurado" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Otro método" }).click();
    await expect(page.getByTestId("checkout-modal")).toHaveCount(0);
    expect(await count()).toBe(before);
  } finally {
    await setFlag("mercadopago_point", false);
    await setFlag("mercadopago_qr", false);
  }
});

// ── 6. Cola offline ─────────────────────────────────────────────────────────
test("cola offline: venta en efectivo sin red se encola y sincroniza una sola vez al volver", async ({
  page,
  context,
}) => {
  await setFlag("pos_offline_queue", true);
  try {
    await login(page);
    await openRegisterIfClosed(page, 20000);
    await page.goto("/pos");
    await expect(page.getByTestId("sync-indicator")).toContainText("SINCRONIZADO");
    await page.getByRole("tab", { name: "Todos" }).click();
    await addToCart(page, PAN);
    const before = await onHand(panId);
    await context.setOffline(true);
    await page.getByTestId("checkout-button").click();
    await page.getByTestId("quick-4000").click();
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    await expect(page.getByTestId("sale-success")).toContainText("Venta guardada sin conexión");
    await page.getByTestId("new-sale").click();
    await expect(page.getByTestId("sync-indicator")).toContainText("OFFLINE (1)");
    // Una segunda venta con tarjeta offline NO se encola (requiere confirmación real)
    await addToCart(page, PAN);
    await page.getByTestId("checkout-button").click();
    await page.getByTestId("pay-tab-card_terminal").click();
    await page.getByTestId("confirm-payment").click();
    await expect(page.getByTestId("checkout-error")).toContainText(
      "Solo las ventas 100% en efectivo",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Vaciar carrito" }).click();
    expect(await onHand(panId)).toBe(before); // nada llegó al servidor
    const queued = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("pdp.pos.offline-queue.v1") ?? "[]"),
    );
    expect(queued).toHaveLength(1);
    const key = queued[0].key as string;
    // Vuelve la red: sincroniza (evento online + intervalo) sin duplicar
    await context.setOffline(false);
    await expect(page.getByTestId("sync-indicator")).toContainText("SINCRONIZADO", {
      timeout: 40_000,
    });
    await expect(
      page.getByRole("status").filter({ hasText: /1 venta\(s\) offline sincronizada/ }),
    ).toBeVisible();
    const synced = await one<{ n: number; sales: number }>(
      sql`select count(*)::int as n, (select count(*)::int from sales s where s.order_id = any(select id from orders where idempotency_key = ${key})) as sales from orders where idempotency_key = ${key}`,
    );
    expect(synced).toEqual({ n: 1, sales: 1 });
    expect(await onHand(panId)).toBe(before - 1);
    // Forzar re-sincronización manual: no duplica
    await page.reload();
    await expect(page.getByTestId("sync-indicator")).toContainText("SINCRONIZADO");
    expect(
      (
        await one<{ n: number }>(
          sql`select count(*)::int as n from orders where idempotency_key = ${key}`,
        )
      ).n,
    ).toBe(1);
    await closeRegisterIfOpen(page);
  } finally {
    await setFlag("pos_offline_queue", false);
  }
});

// ── 7. Concurrencia: dos pestañas, última pieza ─────────────────────────────
test("dos pestañas venden la última pieza (stock negativo prohibido): una gana, la otra recibe error claro", async ({
  page,
  context,
}) => {
  await ensureProduct(ULTIMO, "audit-ultimo-e2e", 3000, 1);
  const salesBefore = (
    await one<{ n: number }>(
      sql`select count(*)::int as n from sales s join order_items oi on oi.order_id = s.order_id where oi.product_id = ${ultimoId}::uuid and s.voided_at is null`,
    )
  ).n;
  await sql`update business_settings set allow_negative_stock = false`.execute(db);
  try {
    await login(page, ADMIN, "/pos");
    const page2 = await context.newPage();
    await page2.goto("/pos");
    for (const p of [page, page2]) {
      await p.getByRole("tab", { name: "Todos" }).click();
      await addToCart(p, ULTIMO);
      await p.getByTestId("checkout-button").click();
      await p.getByTestId("pay-tab-card_terminal").click();
    }
    await Promise.all([
      page.getByTestId("confirm-payment").click(),
      page2.getByTestId("confirm-payment").click(),
    ]);
    const outcome = async (p: Page) => {
      await expect(p.getByTestId("sale-success").or(p.getByTestId("checkout-error"))).toBeVisible();
      return (await p.getByTestId("sale-success").count()) ? "ok" : "error";
    };
    const results = [await outcome(page), await outcome(page2)].sort();
    expect(results).toEqual(["error", "ok"]);
    const loser = (await page.getByTestId("checkout-error").count()) ? page : page2;
    await expect(loser.getByTestId("checkout-error")).toContainText(/Stock insuficiente/);
    expect(await onHand(ultimoId)).toBe(0);
    const sales = await one<{ n: number }>(
      sql`select count(*)::int as n from sales s join order_items oi on oi.order_id = s.order_id where oi.product_id = ${ultimoId}::uuid and s.voided_at is null`,
    );
    expect(sales.n).toBe(salesBefore + 1);
    await page2.close();
  } finally {
    await sql`update business_settings set allow_negative_stock = true`.execute(db);
  }
});

// ── 8. Pedidos ──────────────────────────────────────────────────────────────
test("pedidos: filtros, paginación, cero resultados, URL inválida, pedido manual con cliente nuevo + cupón + pago inicial en TZ, cancelar, notas, devolución", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN, "/pedidos");
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
  await page.goto("/pedidos?vista=todos");
  await expect(page.getByRole("link", { name: "Siguientes →" })).toBeVisible();
  await page.getByRole("link", { name: "Siguientes →" }).click();
  await expect(page).toHaveURL(/pagina=2/);
  await expect(page.getByRole("link", { name: "← Anteriores" })).toBeVisible();
  await page.goto("/pedidos?vista=todos&q=NO-EXISTE-XYZ");
  await expect(page.getByText("Sin pedidos")).toBeVisible();
  await page.goto("/pedidos?vista=todos&estado=refunded&canal=pos");
  await expect(page.getByRole("heading", { name: "Pedidos", exact: true })).toBeVisible();
  await page.goto("/pedidos/not-a-uuid");
  await expect(page.getByText(/404|no se encontró|not found/i).first()).toBeVisible();
  const r404 = await page.request.get("/pedidos/00000000-0000-0000-0000-000000000000", {
    headers: await apiLogin(page.request, page),
  });
  expect(r404.status()).toBe(404);

  // Pedido manual: cliente nuevo, cupón, pago inicial parcial, fecha en TZ del negocio
  const phone = `665${String(Date.now()).slice(-7)}`;
  await page.goto("/pedidos/nuevo");
  const pick = page.locator(`[data-testid^="pick-"][data-product-name="${PAN}"]`);
  await pick.getByRole("button", { name: `Agregar ${PAN}` }).click();
  await pick.getByRole("button", { name: `Agregar ${PAN}` }).click();
  await pick.getByRole("button", { name: `Agregar ${PAN}` }).click();
  await expect(page.getByTestId("cart-total")).toHaveText("$120.00");
  await page.getByRole("button", { name: "Cliente nuevo" }).click();
  await fillField(page, "Nombre *", "Pedido Audit Nuevo");
  await fillField(page, "Teléfono *", phone);
  await page.getByLabel("Tipo").selectOption("scheduled_pickup");
  await page.getByLabel("Fecha y hora *").fill("2026-12-24T18:30");
  await page.getByLabel("Cupón").fill("audit10");
  await page.getByLabel("Registrar pago inicial").check();
  await page.getByLabel("Método").selectOption("transfer");
  await fillField(page, "Monto (MXN)", "50");
  await page.getByRole("button", { name: "Crear pedido" }).click();
  await page.waitForURL(/\/pedidos\/[0-9a-f-]{36}$/);
  const orderId = new URL(page.url()).pathname.split("/").pop()!;
  const o = await one<{
    total_cents: number;
    discount_cents: number;
    paid_cents: number;
    payment_status: string;
    status: string;
    local: string;
    customer_phone: string;
    source: string;
  }>(sql`select o.total_cents, o.discount_cents, o.paid_cents, o.payment_status::text as payment_status, o.status::text as status,
           to_char(o.scheduled_for at time zone (select timezone from business_settings where id = 1), 'YYYY-MM-DD HH24:MI') as local,
           o.customer_phone, c.source
         from orders o join customers c on c.id = o.customer_id where o.id = ${orderId}::uuid`);
  expect(o).toEqual({
    total_cents: 10800,
    discount_cents: 1200,
    paid_cents: 5000,
    payment_status: "partial",
    status: "new",
    local: "2026-12-24 18:30",
    customer_phone: phone,
    source: "admin",
  });
  await expect(page.getByTestId("balance")).toHaveText("$58.00");
  await expect(page.getByTestId("wa-link")).toHaveAttribute(
    "href",
    new RegExp(`wa\\.me/52${phone}`),
  );
  // Refresh y back conservan el detalle
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^PDP-\d{4}-\d{6}$/);
  // Notas internas
  await page.getByPlaceholder("Solo visible para el equipo").fill("nota de auditoría");
  await page.getByRole("button", { name: "Guardar notas" }).click();
  await expect(page.getByText("Notas guardadas")).toBeVisible();
  expect(
    (
      await one<{ internal_notes: string }>(
        sql`select internal_notes from orders where id = ${orderId}::uuid`,
      )
    ).internal_notes,
  ).toBe("nota de auditoría");
  // Transiciones desde "new": confirmado sí, entregado no; cancelar requiere motivo
  const transitions = page.getByTestId("transitions");
  await expect(transitions.getByRole("button", { name: "Confirmado" })).toBeVisible();
  await expect(transitions.getByRole("button", { name: "Entregado" })).toHaveCount(0);
  // Pago del resto en efectivo con cambio → venta + stock
  const stockBefore = await onHand(panId);
  await page.getByLabel("Método").selectOption("cash");
  await fillField(page, "Recibido (efectivo)", "100");
  await page.getByRole("button", { name: "Registrar pago" }).click();
  await expect(page.getByTestId("balance")).toBeHidden();
  expect(await onHand(panId)).toBe(stockBefore - 3);
  const paid = await one<{ status: string; change_cents: number; uses: number }>(
    sql`select o.status::text as status, (select change_cents from payments p where p.order_id = o.id and p.method = 'cash') as change_cents,
               (select uses_count from coupons where code = 'AUDIT10') as uses
         from orders o where o.id = ${orderId}::uuid`,
  );
  expect(paid.status).toBe("paid");
  expect(paid.change_cents).toBe(4200);
  // Ya con venta: no se puede cancelar; sí devolver
  await expect(page.getByRole("button", { name: "Cancelar pedido" })).toHaveCount(0);
  await openReturnForm(page);
  await page.getByLabel("Cantidad").fill("5");
  await page.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Solo se vendieron 3/ })).toBeVisible();
  await page.getByLabel("Cantidad").fill("1");
  await page.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(page.getByText("Devolución registrada", { exact: true })).toBeVisible();
  expect(await onHand(panId)).toBe(stockBefore - 3); // sin restock
  await openReturnForm(page);
  await page.getByLabel("Cantidad").fill("2");
  await page.getByLabel("Reingresar a inventario").check();
  await page.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(page.getByText("Devolución registrada y stock reingresado")).toBeVisible();
  expect(await onHand(panId)).toBe(stockBefore - 1);
  await openReturnForm(page);
  await page.getByLabel("Cantidad").fill("1");
  await page.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Solo se vendieron 3/ })).toBeVisible();
  // Recibo del pedido
  await page.goto(`/pedidos/${orderId}/recibo`);
  await expect(
    page
      .getByText(/PDP-\d{4}-\d{6}/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();

  // Cancelar un pedido sin pago con motivo
  await page.goto("/pedidos/nuevo");
  await pick.getByRole("button", { name: `Agregar ${PAN}` }).click();
  await page.getByLabel("Tipo").selectOption("pickup");
  await page.getByRole("button", { name: "Crear pedido" }).click();
  await page.waitForURL(/\/pedidos\/[0-9a-f-]{36}$/);
  const cancelId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByText("Cancelar pedido").click();
  page.once("dialog", (d) => d.accept());
  await fillField(page, "Motivo", "cliente desistió");
  await page.getByRole("button", { name: "Confirmar cancelación" }).click();
  await expect(page.getByText("Cancelado: cliente desistió")).toBeVisible();
  expect(
    (
      await one<{ status: string }>(
        sql`select status::text as status from orders where id = ${cancelId}::uuid`,
      )
    ).status,
  ).toBe("cancelled");
  await expect(page.getByTestId("transitions")).toHaveCount(0);
});

// ── 9. Producción ───────────────────────────────────────────────────────────
test("producción: +1/+5/+10/+20/manual, deshacer dentro y fuera de ventana, lotes, plan, consumo de insumos", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page, PRODUCTION, "/produccion");
  const card = page.locator(`[data-testid^="product-card-"][data-product-name="${PAN}"]`);
  const start = await onHand(panId);
  const today0 = num(await card.getByTestId("produced-today").textContent());
  const batchCount = () =>
    one<{ n: number; undone: number }>(
      sql`select count(*)::int as n, count(*) filter (where undone_at is not null)::int as undone from production_batches where product_id = ${panId}::uuid`,
    );
  const b0 = await batchCount();
  let acc = 0;
  for (const q of [1, 5, 10, 20]) {
    await card.getByRole("button", { name: `Registrar ${q} de ${PAN}` }).click();
    acc += q;
    await expect(card.getByTestId("on-hand")).toHaveText((start + acc).toLocaleString("es-MX"));
  }
  await card.getByLabel(`Cantidad manual de ${PAN}`).fill("7");
  await card.getByRole("button", { name: "Registrar", exact: true }).click();
  acc += 7;
  await expect(card.getByTestId("on-hand")).toHaveText((start + acc).toLocaleString("es-MX"));
  await expect(card.getByTestId("produced-today")).toHaveText(
    (today0 + acc).toLocaleString("es-MX"),
  );
  expect(await onHand(panId)).toBe(start + acc);
  // Deshacer el último (7) dentro de la ventana
  await page.getByTestId("undo-last").click();
  acc -= 7;
  await expect(card.getByTestId("on-hand")).toHaveText((start + acc).toLocaleString("es-MX"));
  expect(await onHand(panId)).toBe(start + acc);
  // Fuera de la ventana: envejecemos el lote por SQL y el botón debe fallar con mensaje claro
  await card.getByRole("button", { name: `Registrar 1 de ${PAN}` }).click();
  acc += 1;
  await expect(card.getByTestId("on-hand")).toHaveText((start + acc).toLocaleString("es-MX"));
  await sql`update production_batches set created_at = now() - interval '3 minutes' where id = (select id from production_batches where product_id = ${panId}::uuid order by created_at desc limit 1)`.execute(
    db,
  );
  await page.getByTestId("undo-last").click();
  await expect(page.getByRole("alert").filter({ hasText: "2 minutos" })).toBeVisible();
  expect(await onHand(panId)).toBe(start + acc);
  const b1 = await batchCount();
  expect(b1.n - b0.n).toBe(6);
  expect(b1.undone - b0.undone).toBe(1);
  // Lotes
  await page.goto(`/produccion?tab=lotes&producto=${panId}`);
  await expect(page.getByRole("cell", { name: PAN }).first()).toBeVisible();
  await expect(page.getByText("Deshecho").first()).toBeVisible();
  // Plan con pedido comprometido
  const sched = await one<{ ts: string }>(
    sql`select (('2026-11-20 10:00'::timestamp) at time zone (select timezone from business_settings where id = 1))::text as ts`,
  );
  const staff = await one<{ id: string }>(
    sql`select id from staff_users where email = ${ADMIN.email}`,
  );
  const committedBefore = Number(
    (
      await one<{ committed_qty: string }>(
        sql`select committed_qty::text from suggested_production('2026-11-20'::date) where product_id = ${panId}::uuid`,
      )
    ).committed_qty,
  );
  await db.transaction().execute(async (trx) => {
    await sql`select set_config('app.staff_id', ${staff.id}, true)`.execute(trx);
    await sql`select create_order(${JSON.stringify({
      channel: "admin",
      fulfillment_type: "scheduled_pickup",
      scheduled_for: sched.ts,
      customer_name: "Plan Audit",
      items: [{ product_id: panId, qty: 500 }],
      idempotency_key: `aud-plan-${Date.now()}`,
    })}::jsonb)`.execute(trx);
  });
  await page.goto("/produccion?tab=plan&fecha=2026-11-20");
  const planRow = page.getByRole("row", { name: new RegExp(`^${PAN} `) });
  await expect(planRow).toBeVisible();
  const cells = planRow.getByRole("cell");
  expect(num(await cells.nth(1).textContent())).toBe(committedBefore + 500);
  expect(num(await cells.nth(4).textContent())).toBe(
    Math.max(0, committedBefore + 500 - (start + acc)),
  );
  await expect(page.getByText("Plan Audit").first()).toBeVisible();
  await page.goto("/produccion?tab=plan&fecha=2031-01-01");
  await expect(page.getByText("No hay pedidos programados para esta fecha.")).toBeVisible();
  // Consumo de insumos: producto con receta (Concha de vainilla) con flag apagado + checkbox encendido
  const concha = await one<{ id: string }>(
    sql`select id from products where slug = 'concha-vainilla' or name = 'Concha de vainilla' limit 1`,
  );
  const ing = await one<{ ingredient_id: string; qty: string; yield_qty: string; stock: string }>(
    sql`select ri.ingredient_id, ri.qty::text, r.yield_qty::text, i.stock_qty::text as stock from recipes r join recipe_items ri on ri.recipe_id = r.id join ingredients i on i.id = ri.ingredient_id where r.product_id = ${concha.id}::uuid order by ri.sort_order limit 1`,
  );
  await page.goto("/produccion");
  const conchaCard = page.locator(
    `[data-testid^="product-card-"][data-product-name="Concha de vainilla"]`,
  );
  await conchaCard.getByRole("button", { name: "Registrar 1 de Concha de vainilla" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Último lote" })).toBeVisible();
  const s1 = await one<{ stock: string }>(
    sql`select stock_qty::text as stock from ingredients where id = ${ing.ingredient_id}::uuid`,
  );
  expect(Number(s1.stock)).toBe(Number(ing.stock)); // flag apagado: no descuenta
  await page.getByLabel("Descontar ingredientes").check();
  await conchaCard.getByRole("button", { name: "Registrar 10 de Concha de vainilla" }).click();
  await expect(page.getByRole("status").filter({ hasText: "insumos descontados" })).toBeVisible();
  const s2 = await one<{ stock: string }>(
    sql`select stock_qty::text as stock from ingredients where id = ${ing.ingredient_id}::uuid`,
  );
  expect(Number(s2.stock)).toBeCloseTo(
    Number(ing.stock) - (Number(ing.qty) * 10) / Number(ing.yield_qty),
    3,
  );
  await page.getByTestId("undo-last").click();
  await expect(page.getByTestId("undo-last")).toBeHidden();
  const s3 = await one<{ stock: string }>(
    sql`select stock_qty::text as stock from ingredients where id = ${ing.ingredient_id}::uuid`,
  );
  expect(Number(s3.stock)).toBeCloseTo(Number(ing.stock), 3);
});

// ── 10. Inventario ──────────────────────────────────────────────────────────
test("inventario: ajuste, merma inválida, movimientos, conteo completo, conciliación con export CSV, reconstruir niveles, insumos", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN, "/inventario?tab=stock");
  const start = await onHand(panId);
  const stockRow = page.locator(`[data-testid^="stock-row-"][data-product-name="${PAN}"]`);
  await stockRow.getByText("Ajustar").click();
  await stockRow.getByLabel("Tipo").selectOption("correction");
  await stockRow.getByLabel("Cantidad").fill("2.5");
  await stockRow.getByLabel("Sentido (corrección)").selectOption("add");
  await stockRow.getByLabel("Motivo").selectOption("error");
  await stockRow.getByRole("button", { name: "Aplicar ajuste" }).click();
  await expect(page.getByText("Corrección aplicada: +2.5")).toBeVisible();
  expect(await onHand(panId)).toBe(start + 2.5);
  // Merma: cantidad 0 y negativa rechazadas por el servidor (se quita la validación HTML)
  await page.goto("/inventario?tab=mermas");
  await page.getByLabel("Producto").selectOption({ label: PAN });
  await page.getByLabel("Cantidad").evaluate((el) => {
    (el as HTMLInputElement).removeAttribute("min");
    (el as HTMLInputElement).setAttribute("step", "any");
  });
  const wasteCount = () =>
    one<{ n: number }>(
      sql`select count(*)::int as n from waste_records where product_id = ${panId}::uuid`,
    );
  const w0 = (await wasteCount()).n;
  for (const bad of ["0", "-3"]) {
    await page.getByLabel("Cantidad").fill(bad);
    await page.getByRole("button", { name: "Registrar merma" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "mayor a cero" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar merma" })).toBeEnabled();
  }
  expect((await wasteCount()).n).toBe(w0);
  // Hallazgo P3: tras un error React 19 reinicia los campos no controlados (el producto vuelve a "Elige…").
  await expect(page.getByLabel("Producto")).toHaveValue("");
  await page.getByLabel("Producto").selectOption({ label: PAN });
  await page.getByLabel("Cantidad").fill("1.5");
  await page.getByLabel("Motivo").selectOption("gift");
  await page.getByRole("button", { name: "Registrar merma" }).click();
  await expect(page.getByText("Merma registrada: −1.5")).toBeVisible();
  expect(await onHand(panId)).toBe(start + 1);
  const gift = await one<{ type: string }>(
    sql`select type::text as type from inventory_movements where product_id = ${panId}::uuid order by id desc limit 1`,
  );
  expect(gift.type).toBe("GIFT");
  // Movimientos con filtros
  await page.goto(`/inventario?tab=movimientos&producto=${panId}&tipo=GIFT`);
  await expect(page.getByRole("cell", { name: "Regalo" }).first()).toBeVisible();
  await page.goto(`/inventario?tab=movimientos&producto=${panId}&tipo=TRANSFER`);
  await expect(page.getByText("Sin movimientos")).toBeVisible();
  // Conteo: crear → capturar → revisar → aplicar
  await sql`update stock_counts set status = 'discarded', closed_at = now() where status = 'open'`.execute(
    db,
  );
  await page.goto("/inventario?tab=conteo");
  await page.getByLabel("Notas").fill("conteo auditoría");
  await page.getByRole("button", { name: "Crear conteo" }).click();
  await page.waitForURL(/paso=capturar/);
  const countId = new URL(page.url()).searchParams.get("conteo")!;
  const row = page.getByRole("row", { name: new RegExp(`^${PAN} `) });
  const expected = num(await row.getByRole("cell").nth(1).textContent());
  expect(expected).toBe(start + 1);
  await page.getByLabel(`Contado de ${PAN}`).fill(String(expected - 4));
  await page.getByRole("button", { name: /Guardar y revisar/ }).click();
  await page.waitForURL(/paso=revisar/);
  await expect(page.getByRole("row", { name: new RegExp(PAN) }).first()).toContainText("-4");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Aplicar correcciones" }).click();
  await page.waitForURL(/aplicado=1/);
  await expect(page.getByText("Conteo aplicado: 1 corrección")).toBeVisible();
  expect(await onHand(panId)).toBe(start - 3);
  const applied = await one<{ status: string; corr: number }>(
    sql`select status, (select count(*)::int from inventory_movements m where m.ref_type = 'stock_count' and m.ref_id = ${countId}) as corr from stock_counts where id = ${countId}::uuid`,
  );
  expect(applied).toEqual({ status: "applied", corr: 1 });
  await expect(page.getByRole("button", { name: "Crear conteo" })).toBeVisible();
  // Conciliación: rango que cruza mes y export CSV
  await page.goto("/inventario?tab=conciliacion&desde=2026-08-25&hasta=2026-09-05");
  await expect(page.getByRole("heading", { name: "Inventario", exact: true })).toBeVisible();
  const csv = await page.request.get(
    "/inventario/conciliacion/export?desde=2026-08-25&hasta=2026-09-05",
    {
      headers: await apiLogin(page.request, page),
    },
  );
  expect(csv.ok()).toBeTruthy();
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text.split("\r\n")[0]).toContain(
    "producto,apertura,produccion,ventas,mermas,correcciones,otros,cierre",
  );
  expect(text).toContain(PAN);
  const badCsv = await page.request.get("/inventario/conciliacion/export?desde=x&hasta=y", {
    headers: await apiLogin(page.request, page),
  });
  expect(badCsv.status()).toBe(400);
  // Fila de hoy cuadra (cierre = apertura + prod − ventas − mermas ± correcciones ± otros)
  await page.goto("/inventario?tab=conciliacion");
  const recon = page.locator(`[data-testid^="recon-row-"][data-product-name="${PAN}"]`);
  await expect(recon).toBeVisible();
  await expect(recon).not.toHaveClass(/st-red/);
  // Reconstruir niveles (solo gerencia) repara un desfase provocado
  await sql`update inventory_levels set on_hand = on_hand + 100 where product_id = ${panId}::uuid`.execute(
    db,
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reconstruir niveles" }).click();
  await expect(page.getByText("Niveles reconstruidos")).toBeVisible();
  expect(await onHand(panId)).toBe(start - 3);
  // Insumos
  await page.goto("/inventario?tab=insumos");
  await expect(page.getByRole("cell", { name: /Harina/ }).first()).toBeVisible();
});

// ── 11. Notificaciones y cron ───────────────────────────────────────────────
test("notificaciones: listar/filtrar/marcar, contador, cron stock-alerts (401, idempotente, lock)", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await login(page, ADMIN, "/notificaciones");
  const headers = await apiLogin(page.request, page);
  // Sembramos una alerta cerrando stock de un producto de auditoría
  await ensureProduct(ULTIMO, "audit-ultimo-e2e", 3000, 0);
  await sql`update notifications set read_at = now() where entity = 'product' and entity_id = ${ultimoId} and read_at is null`.execute(
    db,
  );
  const denied = await request.get("/api/cron/stock-alerts");
  expect(denied.status()).toBe(401);
  const wrong = await request.post("/api/cron/stock-alerts", {
    headers: { authorization: "Bearer nope" },
  });
  expect(wrong.status()).toBe(401);
  const [c1, c2] = await Promise.all([
    request.post("/api/cron/stock-alerts", { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    request.post("/api/cron/stock-alerts", { headers: { authorization: `Bearer ${CRON_SECRET}` } }),
  ]);
  const j1 = await c1.json();
  const j2 = await c2.json();
  expect(j1.ok && j2.ok).toBe(true);
  const ran = [j1, j2].filter((j) => !j.skipped);
  expect(ran.length).toBeGreaterThanOrEqual(1);
  const third = await request.post("/api/cron/stock-alerts", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  const j3 = await third.json();
  if (!j3.skipped)
    expect(j3.result).toMatchObject({ out_of_stock: 0, low_stock: 0, ingredient_low: 0 });
  const open = await one<{ n: number }>(
    sql`select count(*)::int as n from notifications where entity = 'product' and entity_id = ${ultimoId} and read_at is null and kind = 'out_of_stock'`,
  );
  expect(open.n).toBe(1);
  const runs = await one<{ running: number; ok: number }>(
    sql`select count(*) filter (where status = 'running')::int as running, count(*) filter (where status = 'succeeded')::int as ok from job_runs where job_name = 'stock-alerts'`,
  );
  expect(runs.running).toBe(0);
  expect(runs.ok).toBeGreaterThanOrEqual(1);
  // UI: filtro por tipo, marcar una, contador
  await page.goto("/notificaciones?tipo=out_of_stock&estado=sin_leer");
  const item = page.getByTestId("notification").filter({ hasText: ULTIMO }).first();
  await expect(item).toBeVisible();
  const before = (
    await (await page.request.get("/api/notifications/unread-count", { headers })).json()
  ).unread as number;
  await item.getByRole("button", { name: "Marcar leída" }).click();
  await expect(item).toHaveCount(0);
  const after = (
    await (await page.request.get("/api/notifications/unread-count", { headers })).json()
  ).unread as number;
  expect(after).toBe(before - 1);
  await page.goto("/notificaciones?estado=leidas&tipo=out_of_stock");
  await expect(page.getByTestId("notification").filter({ hasText: ULTIMO }).first()).toBeVisible();
  // Diferencia de caja (generada en la prueba de caja) tiene etiqueta y enlace al corte
  await page.goto("/notificaciones?tipo=register_difference&estado=todas");
  const diffItem = page.getByTestId("notification").first();
  await expect(diffItem).toContainText("Diferencia de caja");
  await expect(diffItem.getByRole("link", { name: /Ver corte/ })).toHaveAttribute(
    "href",
    /\/caja\/[0-9a-f-]{36}/,
  );
  // Marcar todas
  await page.goto("/notificaciones");
  await page.getByRole("button", { name: "Marcar todas como leídas" }).click();
  await expect(page.getByText(/notificaciones marcadas como leídas/)).toBeVisible();
  const zero = (
    await (await page.request.get("/api/notifications/unread-count", { headers })).json()
  ).unread as number;
  expect(zero).toBe(0);
  await expect(page.getByText("Todo al día")).toBeVisible();
});
