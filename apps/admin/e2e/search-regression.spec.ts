import { test, expect, type Page } from "@playwright/test";
import { createDb, sql } from "@pdp/db";
import { hashPassword } from "@pdp/auth";

const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@elpandepaula.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "CambiaEstaClave!2026";

async function login(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto("/login?next=/dashboard");
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactFiber")));
  });
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test.describe("regresión auditoría 360°: búsqueda global", () => {
  test("teléfono con +52 encuentra al cliente y los comodines % _ no devuelven todo", async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now().toString().slice(-7);
    const phone = `664${stamp}`;
    const name = `Busqueda Regresion ${stamp}`;
    // Alta directa por la API de POS (dedupe canónico del teléfono)
    const created = await page.request.post("/api/pos/customers", {
      data: {
        full_name: name,
        phone,
        email: `busqueda-${stamp}@example.com`,
        birthday: "1990-06-15",
      },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(created.ok()).toBeTruthy();

    const intl = await page.request.get(
      `/api/search?q=${encodeURIComponent(`+52 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`)}`,
    );
    expect(intl.status()).toBe(200);
    const intlBody = (await intl.json()) as {
      customers: Array<{ name?: string; full_name?: string }>;
    };
    expect(JSON.stringify(intlBody.customers)).toContain(name);

    const all = await page.request.get(`/api/search?q=${encodeURIComponent("%%")}`);
    expect(all.status()).toBe(200);
    const allBody = (await all.json()) as {
      customers: unknown[];
      orders?: unknown[];
      products?: unknown[];
    };
    expect(allBody.customers.length).toBe(0);

    const underscore = await page.request.get(`/api/search?q=${encodeURIComponent("a_")}`);
    const uBody = (await underscore.json()) as { customers: unknown[] };
    expect(uBody.customers.length).toBe(0);
  });
});

test.describe("regresión auditoría 360°: la búsqueda respeta permisos", () => {
  test("un usuario de Producción (sin customers.read) no recibe clientes; sí productos", async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop", "API pura: basta un proyecto");
    const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
    const prod = { email: "busqueda-produccion@audit.local", password: "AuditBusqueda!2026" };
    const stamp = Date.now().toString().slice(-7);
    try {
      await sql`insert into staff_users(email, full_name, password_hash, role_key, is_active, must_change_password)
                values (${prod.email}, 'Producción Búsqueda', ${await hashPassword(prod.password)}, 'production', true, false)
                on conflict (email) do update set password_hash = excluded.password_hash, role_key = 'production', is_active = true,
                  must_change_password = false, failed_logins = 0, locked_until = null, deleted_at = null`.execute(
        db,
      );
      await sql`select register_customer(${JSON.stringify({ full_name: `Zulema Permisos ${stamp}`, phone: `664${stamp}`, allow_incomplete: true })}::jsonb)`.execute(
        db,
      );
    } finally {
      await db.destroy();
      await pool.end().catch(() => {});
    }
    await login(page, prod.email, prod.password);
    const r = await page.request.get(
      `/api/search?q=${encodeURIComponent(`Zulema Permisos ${stamp}`)}`,
    );
    expect(r.status()).toBe(200);
    const body = (await r.json()) as { customers: unknown[]; products: unknown[] };
    expect(body.customers).toEqual([]);
    const products = await page.request.get(`/api/search?q=${encodeURIComponent("croissant")}`);
    expect(((await products.json()) as { products: unknown[] }).products.length).toBeGreaterThan(0);
  });
});
