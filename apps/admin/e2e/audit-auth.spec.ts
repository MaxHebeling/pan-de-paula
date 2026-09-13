import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Auditoría de autenticación, autorización y administración (audit/auth).
 * Corre contra un servidor ya levantado (E2E_BASE_URL) con el seed base (admin super_admin).
 * Cada proyecto de Playwright crea sus propios usuarios (email único) para no pisarse.
 * Sin `networkidle`: se espera por URL o por elementos.
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

/** El primer fill puede perderse al hidratar React: reintenta hasta que el valor quede. */
async function fillField(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  for (let i = 0; i < 5; i++) {
    await field.fill(value);
    await page.waitForTimeout(150);
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`No se pudo escribir en "${label}"`);
}

async function submitLogin(page: Page, email: string, password: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.waitForLoadState("domcontentloaded");
  await fillField(page, "Correo", email);
  await fillField(page, "Contraseña", password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

async function loginAs(page: Page, email: string, password: string, next?: string) {
  await submitLogin(page, email, password, next);
  // Falla rápido y con causa si el login fue rechazado (p. ej. rate limit por IP tras muchas corridas seguidas).
  await Promise.race([
    page.waitForURL((u) => u.pathname !== "/login"),
    page
      .locator('p[role="alert"]')
      .waitFor({ state: "visible" })
      .then(async () => {
        throw new Error(`Login rechazado: ${await page.locator('p[role="alert"]').textContent()}`);
      }),
  ]);
}

async function sessionCookie(context: BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((c) => c.name === "pdp_session");
}

const uniq = (prefix: string, testInfo: { project: { name: string } }) =>
  `${prefix}-${testInfo.project.name}-${Date.now().toString(36)}@audit.local`;

/** Crea un usuario desde /usuarios (como admin) y devuelve la contraseña temporal mostrada una sola vez. */
async function createUserViaUi(page: Page, email: string, name: string, roleLabel: string) {
  await page.goto("/usuarios");
  await page.waitForLoadState("domcontentloaded");
  await fillField(page, "Nombre completo", name);
  await fillField(page, "Correo", email);
  await page.getByLabel("Rol", { exact: true }).selectOption({ label: roleLabel });
  await page.getByRole("button", { name: "Crear usuario" }).click();
  const secret = page.locator('div[role="status"]', { hasText: "Contraseña temporal" });
  await expect(secret).toBeVisible();
  const temp = (await secret.locator("code").textContent())?.trim();
  if (!temp) throw new Error("No se mostró la contraseña temporal");
  return temp;
}

test.describe.configure({ mode: "serial" });

test("rutas privadas y /api sin sesión: redirigen a /login y nunca devuelven datos", async ({
  page,
  request,
}) => {
  await page.goto("/usuarios");
  await page.waitForURL((u) => u.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/usuarios");

  const r = await request.get("/api/search?q=pan", { maxRedirects: 0 });
  expect([307, 308, 401]).toContain(r.status());
  expect(r.headers()["content-type"] ?? "").not.toContain("application/json");

  const r2 = await request.get("/api/notifications/unread-count", { maxRedirects: 0 });
  expect([307, 308, 401]).toContain(r2.status());

  const h = await request.get("/login");
  expect(h.headers()["x-frame-options"]).toBe("DENY");
  expect(h.headers()["x-content-type-options"]).toBe("nosniff");
  expect(h.headers()["x-powered-by"]).toBeUndefined();
});

test("login: credenciales malas y usuario inexistente responden igual; login OK con cookie httpOnly/Lax", async ({
  page,
  context,
}) => {
  await submitLogin(page, ADMIN_EMAIL, "clave-incorrecta-1");
  const alert = page.locator('p[role="alert"]');
  await expect(alert).toHaveText("Correo o contraseña incorrectos.");
  expect(await sessionCookie(context)).toBeUndefined();

  await submitLogin(page, "nadie-" + Date.now() + "@audit.local", "clave-incorrecta-1");
  await expect(page.locator('p[role="alert"]')).toHaveText("Correo o contraseña incorrectos.");

  await submitLogin(page, "no-es-un-correo", "x");
  await expect(page.locator('p[role="alert"]')).toContainText("correo válido");

  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(new URL(page.url()).pathname).toBe("/dashboard");
  const c = await sessionCookie(context);
  expect(c).toBeDefined();
  expect(c!.httpOnly).toBe(true);
  expect(c!.sameSite).toBe("Lax");
  expect(c!.value.length).toBeGreaterThanOrEqual(40);
  // La cookie no es legible desde JS
  expect(await page.evaluate(() => document.cookie)).not.toContain("pdp_session");
});

test("open redirect: next=//evil, /\\evil, https://evil y /api/... no sacan del sitio", async ({
  page,
}) => {
  const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3001");
  for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "/api/search"]) {
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD, next);
    const u = new URL(page.url());
    expect(u.host).toBe(base.host);
    expect(u.pathname).toBe("/dashboard");
    await page.request.post("/api/auth/logout");
  }
  // next legítimo sí se respeta
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD, "/auditoria");
  expect(new URL(page.url()).pathname).toBe("/auditoria");
});

test("logout revoca la sesión: la cookie vieja ya no entra; CSRF cross-origin al logout se rechaza", async ({
  page,
  context,
  browser,
}) => {
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const c = (await sessionCookie(context))!;

  // CSRF: un POST con Origin ajeno no cierra la sesión (403) y la sesión sigue viva
  const csrf = await page.request.post("/api/auth/logout", {
    headers: { origin: "https://evil.example" },
    maxRedirects: 0,
  });
  expect(csrf.status()).toBe(403);
  await page.goto("/dashboard");
  expect(new URL(page.url()).pathname).toBe("/dashboard");

  // Logout real desde la UI
  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  await page.waitForURL((u) => u.pathname === "/login");

  // Reutilizar la cookie vieja en otro navegador limpio
  const ctx2 = await browser.newContext();
  await ctx2.addCookies([{ name: "pdp_session", value: c.value, domain: c.domain, path: "/" }]);
  const p2 = await ctx2.newPage();
  await p2.goto("/dashboard");
  await p2.waitForURL((u) => u.pathname === "/login");
  await ctx2.close();
});

test("/recuperar responde igual exista o no la cuenta (también bajo rate limit)", async ({
  page,
}) => {
  const ALLOWED = [
    /Si el correo pertenece a una cuenta activa/,
    /Demasiadas solicitudes\. Intenta de nuevo en 15 minutos\./,
  ];
  const submit = async (email: string) => {
    await page.goto("/recuperar");
    await page.waitForLoadState("domcontentloaded");
    await fillField(page, "Correo", email);
    await page.getByRole("button", { name: "Enviar enlace" }).click();
    const msg = page.locator('p[role="status"], p[role="alert"]').first();
    await expect(msg).toBeVisible();
    return (await msg.textContent())!.trim();
  };
  // inexistente → existente → inexistente: si los extremos coinciden, el del medio debe ser idéntico
  // (el límite de 5 solicitudes/IP/15 min puede activarse entre corridas; nunca debe revelar la cuenta).
  const a = await submit("inexistente-" + Date.now() + "@audit.local");
  const b = await submit(ADMIN_EMAIL);
  const c = await submit("inexistente2-" + Date.now() + "@audit.local");
  for (const m of [a, b, c]) {
    expect(
      ALLOWED.some((re) => re.test(m)),
      `mensaje inesperado: ${m}`,
    ).toBe(true);
    expect(m).not.toMatch(/no existe|no encontrado|desactivad/i);
  }
  if (a === c) expect(b).toBe(a);
});

test("admin: crea usuario (contraseña temporal una sola vez) → primer acceso fuerza cambio → política → rol limita páginas y acciones → desactivar cierra sesión", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const email = uniq("caja", testInfo);
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const temp = await createUserViaUi(page, email, "Caja Auditoría", "Caja");
  expect(temp).toMatch(/^[A-Za-z0-9]{14}$/);

  // La lista lo muestra con "Debe cambiar contraseña" y sin sesiones; al refrescar NO reaparece la contraseña
  await page.goto("/usuarios");
  const row = page.locator("tr", { hasText: email });
  await expect(row).toContainText("Debe cambiar contraseña");
  await expect(page.locator('div[role="status"]', { hasText: "Contraseña temporal" })).toHaveCount(
    0,
  );

  // Doble envío del mismo correo: error claro, no duplicado
  await fillField(page, "Nombre completo", "Duplicado");
  await fillField(page, "Correo", email.toUpperCase());
  await page.getByRole("button", { name: "Crear usuario" }).click();
  await expect(page.locator('p[role="alert"]')).toContainText("Ya existe");

  // ── El nuevo usuario entra ──
  const ctxUser = await browser.newContext();
  const u = await ctxUser.newPage();
  await loginAs(u, email, temp);
  expect(new URL(u.url()).pathname).toBe("/cuenta/contrasena");
  // No puede saltarse el cambio
  await u.goto("/pos");
  await u.waitForURL((x) => x.pathname === "/cuenta/contrasena");
  // Política: corta, sin números, distinta a la actual, confirmación
  const tryChange = async (current: string, next: string, confirm: string) => {
    await u.goto("/cuenta/contrasena?forzado=1");
    await u.waitForLoadState("domcontentloaded");
    await fillField(u, "Contraseña actual", current);
    await fillField(u, "Nueva contraseña", next);
    await fillField(u, "Confirmar nueva contraseña", confirm);
    await u.getByRole("button", { name: "Guardar" }).click();
  };
  await tryChange(temp, "corta1", "corta1");
  // El navegador bloquea el envío (minLength=10); el servidor repite la política (cubierto en @pdp/auth y en /restablecer).
  expect(
    await u
      .getByLabel("Nueva contraseña", { exact: true })
      .evaluate((e) => (e as HTMLInputElement).validity.tooShort),
  ).toBe(true);
  expect(new URL(u.url()).pathname).toBe("/cuenta/contrasena");
  await tryChange(temp, "sinnumerosaqui", "sinnumerosaqui");
  await expect(u.locator('p[role="alert"]')).toContainText("letras y números");
  await tryChange(temp, "ClaveNueva2026", "ClaveNueva2027");
  await expect(u.locator('p[role="alert"]')).toContainText("no coinciden");
  await tryChange("otra-actual-1", "ClaveNueva2026", "ClaveNueva2026");
  await expect(u.locator('p[role="alert"]')).toContainText("actual no es correcta");
  await tryChange(temp, temp, temp);
  await expect(u.locator('p[role="alert"]')).toContainText("distinta a la actual");
  const newPw = "Clave con espacios 2026";
  await tryChange(temp, newPw, newPw);
  await u.waitForURL((x) => x.pathname === "/dashboard");

  // ── Autorización de caja: páginas ──
  for (const path of ["/usuarios", "/configuracion", "/auditoria", "/produccion", "/recetas"]) {
    await u.goto(path);
    await u.waitForURL((x) => x.pathname === "/403");
  }
  await u.goto("/pos");
  expect(new URL(u.url()).pathname).toBe("/pos");
  // El menú no ofrece secciones prohibidas
  await u.goto("/dashboard");
  const nav = u.getByRole("navigation", { name: "Principal" }).first();
  await expect(nav.getByRole("link", { name: "Usuarios" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Configuración" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Auditoría" })).toHaveCount(0);

  // ── Autorización de caja: endpoints directos ──
  const rep = await u.request.get("/api/reports/export?type=sales", { maxRedirects: 0 });
  expect(rep.status()).toBe(403);
  const inv = await u.request.get("/inventario/conciliacion/export", { maxRedirects: 0 });
  expect([401, 403]).not.toContain(inv.status()); // cashier tiene inventory.read (400 = faltan parámetros, no un rechazo)
  const refundAttempt = await u.request.post("/api/pos/checkout", {
    data: { items: [] },
    headers: { origin: new URL(u.url()).origin },
  });
  expect([400, 403]).toContain(refundAttempt.status()); // nunca 500 ni éxito sin líneas

  // ── Auditoría del alta con staff_id del admin ──
  await page.goto(`/auditoria?entidad=staff_users&accion=INSERT&q=${encodeURIComponent(email)}`);
  const audit = page.locator("details", { hasText: email }).first();
  await expect(audit).toContainText("INSERT");
  await expect(audit).toContainText("Administrador");
  await audit.locator("summary").click();
  await expect(audit).not.toContainText("password_hash");
  await expect(audit).not.toContainText("$argon2");
  // El cambio de contraseña del propio usuario queda auditado con su identidad (no como "sistema")
  await page.goto("/auditoria?accion=PASSWORD_CHANGED");
  const changed = page.locator("details", { hasText: "Caja Auditoría" }).first();
  await expect(changed).toContainText("PASSWORD_CHANGED");
  await expect(changed).not.toContainText("sistema");
  // Filtros basura no tumban la página
  await page.goto("/auditoria?usuario=no-es-uuid&desde=garbage&hasta=2026-13-45&pagina=-3");
  await expect(page.getByRole("heading", { name: "Auditoría" })).toBeVisible();
  await page.goto("/usuarios/no-es-uuid");
  expect(await page.title()).toMatch(/404|encontr/i);

  // ── Admin desactiva al usuario: su sesión muere y no puede volver a entrar ──
  await page.goto("/usuarios");
  await page.locator("tr", { hasText: email }).getByRole("link", { name: "Gestionar" }).click();
  await page.waitForURL((x) => /\/usuarios\/[0-9a-f-]{36}$/.test(x.pathname));
  await expect(page.getByText("Sesiones activas (1)")).toBeVisible();
  await page.getByLabel("Cuenta activa").uncheck();
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator('p[role="status"]')).toContainText("Usuario guardado");
  await u.goto("/pos");
  await u.waitForURL((x) => x.pathname === "/login");
  await submitLogin(u, email, newPw);
  await expect(u.locator('p[role="alert"]')).toHaveText("Tu cuenta está desactivada.");
  await submitLogin(u, email, "clave-equivocada-1");
  await expect(u.locator('p[role="alert"]')).toHaveText("Correo o contraseña incorrectos.");
  await ctxUser.close();
});

test("enlace de restablecimiento: un solo uso, revoca sesiones; production aterriza en una página permitida", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(150_000);
  const email = uniq("prod", testInfo);
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const temp = await createUserViaUi(page, email, "Producción Auditoría", "Producción");

  // El usuario entra y cambia su clave: debe aterrizar en /pedidos (no tiene dashboard.read), nunca en /403
  const ctxUser = await browser.newContext();
  const u = await ctxUser.newPage();
  await loginAs(u, email, temp);
  await u.waitForLoadState("domcontentloaded");
  await fillField(u, "Contraseña actual", temp);
  await fillField(u, "Nueva contraseña", "Produccion2026x");
  await fillField(u, "Confirmar nueva contraseña", "Produccion2026x");
  await u.getByRole("button", { name: "Guardar" }).click();
  await u.waitForURL((x) => x.pathname === "/pedidos");
  // Segundo login directo también aterriza bien
  await u.request.post("/api/auth/logout");
  await loginAs(u, email, "Produccion2026x");
  expect(new URL(u.url()).pathname).toBe("/pedidos");
  // production no vende ni cobra
  await u.goto("/pos");
  await u.waitForURL((x) => x.pathname === "/403");
  const cust = await u.request.get("/api/pos/customers?q=a", { maxRedirects: 0 });
  expect(cust.status()).toBe(403);

  // Admin genera enlace de restablecimiento (se muestra una sola vez y queda auditado)
  await page.goto("/usuarios");
  await page.locator("tr", { hasText: email }).getByRole("link", { name: "Gestionar" }).click();
  await page.getByRole("button", { name: "Generar enlace" }).click();
  const secret = page.locator('div[role="status"]', { hasText: "Enlace de restablecimiento" });
  await expect(secret).toBeVisible();
  const link = (await secret.locator("code").textContent())!.trim();
  const token = new URL(link).searchParams.get("token")!;
  expect(token.length).toBeGreaterThanOrEqual(24);

  // Otro navegador usa el enlace
  const ctxReset = await browser.newContext();
  const r = await ctxReset.newPage();
  await r.goto(`/restablecer?token=${encodeURIComponent(token)}`);
  await r.waitForLoadState("domcontentloaded");
  await fillField(r, "Nueva contraseña", "Restablecida2026");
  await fillField(r, "Confirmar contraseña", "Restablecida2026");
  await r.getByRole("button", { name: "Guardar contraseña" }).click();
  await r.waitForURL((x) => x.pathname === "/login" && x.searchParams.get("restablecida") === "1");
  await expect(r.locator('p[role="status"]')).toContainText("Contraseña actualizada");

  // La sesión previa del usuario quedó revocada
  await u.goto("/pedidos");
  await u.waitForURL((x) => x.pathname === "/login");
  // La clave anterior ya no sirve; la nueva sí
  await submitLogin(u, email, "Produccion2026x");
  await expect(u.locator('p[role="alert"]')).toHaveText("Correo o contraseña incorrectos.");
  await loginAs(u, email, "Restablecida2026");
  expect(new URL(u.url()).pathname).toBe("/pedidos");

  // El enlace ya no sirve una segunda vez
  await r.goto(`/restablecer?token=${encodeURIComponent(token)}`);
  await r.waitForLoadState("domcontentloaded");
  await fillField(r, "Nueva contraseña", "OtraVez2026xx");
  await fillField(r, "Confirmar contraseña", "OtraVez2026xx");
  await r.getByRole("button", { name: "Guardar contraseña" }).click();
  await expect(r.locator('p[role="alert"]')).toContainText("no es válido o ya venció");
  // Token inventado / sin token
  await r.goto("/restablecer");
  await expect(r.getByText("Falta el token del enlace")).toBeVisible();

  // Auditoría: PASSWORD_RESET_LINK (admin) y PASSWORD_RESET (el propio usuario)
  await page.goto("/auditoria?accion=PASSWORD_RESET_LINK");
  await expect(page.locator("details", { hasText: email }).first()).toContainText("Administrador");
  await page.goto("/auditoria?accion=PASSWORD_RESET");
  await expect(page.locator("details", { hasText: "Producción Auditoría" }).first()).toBeVisible();

  // Admin cierra todas las sesiones del usuario desde su ficha
  await page.goto("/usuarios");
  await page.locator("tr", { hasText: email }).getByRole("link", { name: "Gestionar" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Cerrar todas las sesiones" }).click();
  await expect(page.getByText("Sesiones activas (0)")).toBeVisible();
  await u.goto("/pedidos");
  await u.waitForURL((x) => x.pathname === "/login");
  await ctxReset.close();
  await ctxUser.close();
});

test("jerarquía: nadie asigna un rol superior al suyo (owner no crea super_admin; el select no lo ofrece; no puede desactivarse a sí mismo)", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const email = uniq("owner", testInfo);
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  const temp = await createUserViaUi(page, email, "Dueño Auditoría", "Dueño");

  const ctx = await browser.newContext();
  const o = await ctx.newPage();
  await loginAs(o, email, temp);
  await fillField(o, "Contraseña actual", temp);
  await fillField(o, "Nueva contraseña", "Dueno2026xyz");
  await fillField(o, "Confirmar nueva contraseña", "Dueno2026xyz");
  await o.getByRole("button", { name: "Guardar" }).click();
  await o.waitForURL((x) => x.pathname === "/dashboard");

  await o.goto("/usuarios");
  const options = await o.getByLabel("Rol", { exact: true }).locator("option").allTextContents();
  expect(options).not.toContain("Super Admin");
  expect(options).toContain("Dueño");
  // El super_admin aparece como "rol superior" sin botón Gestionar
  const adminRow = o.locator("tr", { hasText: ADMIN_EMAIL });
  await expect(adminRow).toContainText("rol superior");
  await expect(adminRow.getByRole("link", { name: "Gestionar" })).toHaveCount(0);
  // URL directa a la ficha del super_admin: rebota a /usuarios
  const adminHref = await page
    .locator("tr", { hasText: ADMIN_EMAIL })
    .getByRole("link", { name: "Gestionar" })
    .getAttribute("href");
  await o.goto(adminHref!);
  await o.waitForURL((x) => x.pathname === "/usuarios");
  // Su propia ficha: rol y estado deshabilitados
  await o.locator("tr", { hasText: email }).getByRole("link", { name: "Gestionar" }).click();
  await expect(o.getByLabel("Rol", { exact: true })).toBeDisabled();
  await expect(o.getByLabel("Cuenta activa")).toBeDisabled();
  await ctx.close();

  // Limpieza: el admin desactiva al dueño de prueba
  await page.goto("/usuarios");
  await page.locator("tr", { hasText: email }).getByRole("link", { name: "Gestionar" }).click();
  await page.getByLabel("Cuenta activa").uncheck();
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.locator('p[role="status"]')).toContainText("Usuario guardado");
});

test("configuración: guardar → refrescar → persiste (y queda en auditoría con el actor)", async ({
  page,
}, testInfo) => {
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto("/configuracion?tab=negocio");
  await page.waitForLoadState("domcontentloaded");
  const original = await page.getByLabel("Lema", { exact: true }).inputValue();
  const marker = `Lema auditoría ${testInfo.project.name} ${Date.now().toString(36)} ñ 🥐`;
  await fillField(page, "Lema", marker);
  await page.getByRole("button", { name: "Guardar" }).first().click();
  await expect(page.locator('p[role="status"]')).toContainText("guardados");
  await page.goto("/configuracion?tab=negocio");
  await expect(page.getByLabel("Lema", { exact: true })).toHaveValue(marker);

  await page.goto(`/auditoria?entidad=business_settings`);
  const row = page.locator("details", { hasText: marker }).first();
  await expect(row).toContainText("UPDATE");
  await expect(row).toContainText("Administrador");

  // Campo inválido: nombre comercial de 1 letra → error de validación del servidor, no 500
  await page.goto("/configuracion?tab=negocio");
  await fillField(page, "Nombre comercial", "X");
  await page.getByRole("button", { name: "Guardar" }).first().click();
  await expect(page.locator('p[role="alert"]')).toContainText("Nombre muy corto");
  await page.goto("/configuracion?tab=negocio");
  await expect(page.getByLabel("Nombre comercial", { exact: true })).not.toHaveValue("X");

  // Restaurar
  await page.goto("/configuracion?tab=negocio");
  await fillField(page, "Lema", original);
  await page.getByRole("button", { name: "Guardar" }).first().click();
  await expect(page.locator('p[role="status"]')).toContainText("guardados");
});
