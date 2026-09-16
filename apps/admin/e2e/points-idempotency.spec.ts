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

test("regresión auditoría 360°: doble envío del ajuste de puntos suma una sola vez", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "basta un proyecto");
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
  const stamp = Date.now().toString().slice(-7);
  let id = "";
  try {
    const r = await sql<{
      r: { customer_id: string };
    }>`select register_customer(${JSON.stringify({ full_name: `Puntos Doble ${stamp}`, phone: `663${stamp}`, allow_without_email: true })}::jsonb) as r`.execute(
      db,
    );
    id = r.rows[0]!.r.customer_id;
    await login(page, `/clientes/${id}`);
    await page.waitForURL(new RegExp(`/clientes/${id}`));
    await page.waitForFunction(() => {
      const f = document.querySelector("#points")?.closest("form");
      return Boolean(f && Object.keys(f).some((k) => k.startsWith("__reactFiber")));
    });
    await page.fill("#points", "7");
    await page.fill("#reason", "Doble envío E2E");
    // Dos envíos inmediatos del MISMO formulario (misma clave de idempotencia)
    await page.evaluate(() => {
      const f = document.querySelector("#points")!.closest("form")!;
      f.requestSubmit();
      f.requestSubmit();
    });
    await expect(page.getByRole("status")).toContainText("Nuevo saldo: 7", { timeout: 15_000 });
    await expect
      .poll(async () => {
        const n = await sql<{ n: number; bal: number }>`
          select (select count(*)::int from loyalty_transactions where customer_id = ${id} and kind = 'adjust') as n,
                 (select points_balance from customers where id = ${id}) as bal`.execute(db);
        return n.rows[0];
      })
      .toEqual({ n: 1, bal: 7 });
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
});
