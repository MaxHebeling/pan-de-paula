import { expect, test, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";
import { hashPassword } from "@pdp/auth";

/**
 * Encabezado del dashboard: saludo, nombre, rol, hora en vivo, fecha y lugar.
 *
 * Las cuatro franjas se prueban de verdad, no de mentira: se fija la hora del navegador con el reloj
 * de Playwright y la zona horaria del contexto, así que lo que se comprueba es lo que vería alguien
 * conectado a esa hora en esa ciudad. Y el reloj se comprueba AVANZANDO el tiempo: que el número
 * cambie solo, sin recargar, es justo lo que se pidió.
 *
 * Nada está escrito a mano en el componente: el nombre y el rol salen de la sesión, así que estas
 * mismas pruebas valen para cualquier usuario futuro.
 */
const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 2 });
const stamp = Date.now().toString().slice(-7);

const CEO = { email: `paulina.e2e.${stamp}@example.com`, pass: "ClaveDePrueba!2026" };
const ADMIN = { email: `karla.e2e.${stamp}@example.com`, pass: "ClaveDePrueba!2026" };

test.describe.configure({ mode: "serial" });
test.skip(() => test.info().project.name !== "desktop", "basta un proyecto");

test.beforeAll(async () => {
  const hash = await hashPassword(CEO.pass);
  for (const [u, nombre, rol] of [
    [CEO, "Paulina Gonzalez", "ceo"],
    [ADMIN, "Karla Santoyo Escarcega", "admin"],
  ] as const) {
    await sql`insert into staff_users(email, full_name, password_hash, role_key, is_active, must_change_password)
              values (${u.email}, ${nombre}, ${hash}, ${rol}, true, false)
              on conflict (email) do update set password_hash = excluded.password_hash,
                role_key = excluded.role_key, full_name = excluded.full_name,
                is_active = true, must_change_password = false, failed_logins = 0, locked_until = null`.execute(
      db,
    );
  }
});

test.afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

async function entrar(page: Page, u: { email: string; pass: string }) {
  await page.context().clearCookies();
  for (let i = 0; i < 4; i++) {
    await page.goto("/login?next=/dashboard");
    await page.waitForLoadState("domcontentloaded");
    await page.fill("#email", u.email);
    await page.fill("#password", u.pass);
    await page.getByRole("button", { name: "Entrar" }).click();
    const ok = await page
      .waitForURL((x) => !x.pathname.startsWith("/login"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
  throw new Error(`No se pudo entrar como ${u.email}`);
}

test("la CEO y la administradora entran, ven su nombre y su rol, y tienen acceso completo", async ({
  page,
}) => {
  test.setTimeout(150_000);

  await entrar(page, CEO);
  await expect(page.getByTestId("dashboard-hero")).toBeVisible();
  await expect(page.getByTestId("hero-saludo")).toContainText("Paulina");
  await expect(page.getByTestId("hero-rol")).toHaveText("CEO");

  // Acceso completo de verdad: las secciones responden 200, no solo aparecen en el menú.
  const modulos = [
    "/dashboard",
    "/clientes",
    "/productos",
    "/produccion",
    "/inventario",
    "/pedidos",
    "/pos",
    "/caja",
    "/reportes",
    "/fidelizacion",
    "/configuracion",
    "/usuarios",
    "/auditoria",
  ];
  for (const ruta of modulos) {
    const res = await page.request.get(ruta);
    expect(res.status(), ruta).toBeLessThan(400);
  }

  await entrar(page, ADMIN);
  await expect(page.getByTestId("hero-saludo")).toContainText("Karla");
  await expect(page.getByTestId("hero-rol")).toHaveText("Administradora");
  for (const ruta of modulos) {
    const res = await page.request.get(ruta);
    expect(res.status(), ruta).toBeLessThan(400);
  }
});

test("el saludo, el icono y la hora siguen al momento del día de QUIEN mira", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  /*
   * Las horas llevan el desfase de Tijuana (−07:00 en septiembre) EXPLÍCITO. Sin él, `new Date` las
   * interpreta en la zona de la máquina que corre la prueba: en esta Mac daba la mañana y en CI, que
   * va en UTC, la madrugada. El instante debe ser el mismo en cualquier máquina.
   */
  const casos = [
    { hora: "2026-09-21T08:30:00-07:00", franja: "manana", saludo: "Buenos días" },
    { hora: "2026-09-21T12:30:00-07:00", franja: "mediodia", saludo: "Buenas tardes" },
    { hora: "2026-09-21T15:42:00-07:00", franja: "tarde", saludo: "Buenas tardes" },
    { hora: "2026-09-21T21:10:00-07:00", franja: "noche", saludo: "Buenas noches" },
  ];

  for (const caso of casos) {
    const ctx = await browser.newContext({ timezoneId: "America/Tijuana", locale: "es-MX" });
    const page = await ctx.newPage();
    // El reloj del navegador se fija ANTES de cargar nada: el componente ve esa hora como la real.
    await page.clock.install({ time: new Date(caso.hora) });
    await entrar(page, CEO);

    await expect(page.getByTestId("hero-saludo"), caso.franja).toContainText(caso.saludo);
    await expect(page.getByTestId("hero-icono")).toHaveAttribute("data-franja", caso.franja);
    // Hora y fecha, en el formato claro que se pidió (no 09/21/26).
    await expect(page.getByTestId("hero-hora")).toContainText(/\d{1,2}:\d{2}:\d{2}\s?[ap]\.?\s?m/i);
    await expect(page.getByTestId("hero-fecha")).toContainText("21 de septiembre de 2026");
    await expect(page.getByTestId("hero-fecha")).toContainText("lunes");
    // La ciudad sale de la zona horaria del dispositivo, sin pedirle permiso a nadie.
    await expect(page.getByTestId("hero-lugar")).toHaveText("📍 Tijuana, México");

    await ctx.close();
  }
});

test("el reloj avanza solo, sin recargar la página", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ timezoneId: "America/Monterrey", locale: "es-MX" });
  const page = await ctx.newPage();
  /*
   * `pauseAt` congela el reloj del navegador en esa hora ANTES de entrar (no puede retroceder, así
   * que se pausa primero y luego se navega). Después se compara el reloj contra sí mismo: la prueba
   * no depende de la zona horaria del equipo que la corre, solo de lo que importa aquí — que el
   * número avance solo, sin recargar.
   */
  await page.clock.pauseAt(new Date("2026-09-21T15:42:10-06:00"));
  await entrar(page, ADMIN);

  const reloj = page.getByTestId("hero-hora");
  const segundos = async () => {
    const t = (await reloj.textContent()) ?? "";
    const m = /(\d{1,2}):(\d{2}):(\d{2})/.exec(t);
    expect(m, `hora ilegible: "${t}"`).not.toBeNull();
    return Number(m![3]);
  };
  // Con el reloj congelado, los temporizadores de React no corren: se le da un segundo para que el
  // componente monte y pinte su primera hora.
  await page.clock.runFor(1000);
  const antes = await segundos();
  await page.clock.runFor(5000);
  await expect.poll(segundos).toBe((antes + 5) % 60);

  // Y el mismo usuario en otra ciudad ve SU ciudad, no la del negocio.
  await expect(page.getByTestId("hero-lugar")).toHaveText("📍 Monterrey, México");
  await ctx.close();
});

test("una zona horaria desconocida no inventa un lugar", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ timezoneId: "UTC", locale: "es-MX" });
  const page = await ctx.newPage();
  await entrar(page, CEO);
  // "UTC" no es una ciudad: se dice que no se sabe, en vez de escribir cualquier cosa.
  await expect(page.getByTestId("hero-lugar")).toHaveText("Ubicación no disponible");
  await ctx.close();
});
