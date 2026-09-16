/**
 * Auditoría del club (registro y tarjeta) contra Postgres real.
 * La tarjeta pública SOLO debe abrirse con el token opaco; teléfono, correo o código PDP no deben servir.
 * Registrar un teléfono ya existente no debe redirigir a la tarjeta ajena ni modificar esa cuenta.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, sql, type Database } from "@pdp/db";
import { webTestDatabaseUrl } from "./db-url.ts";

let ip = "203.0.113.50";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": ip }),
}));

type Join = typeof import("../app/unete/actions");
type Customers = typeof import("../lib/customers");
let joinClubAction: Join["joinClubAction"];
let findCustomer: Customers["findCustomer"];
let findCustomerByQrToken: Customers["findCustomerByQrToken"];
let db: Database;
let pool: { end: () => Promise<void> };

const form = (f: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.set(k, v);
  return fd;
};

/** redirect() de Next lanza un error con digest "NEXT_REDIRECT;…;/ruta;…". */
async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2] ?? "";
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = webTestDatabaseUrl();
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3113";
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  ({ db, pool } = createDb({ connectionString: process.env.DATABASE_URL, ssl: false, max: 4 }));
  ({ joinClubAction } = await import("../app/unete/actions"));
  ({ findCustomer, findCustomerByQrToken } = await import("../lib/customers"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.destroy();
  await pool.end().catch(() => {});
});
beforeEach(async () => {
  ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  await sql`truncate table loyalty_transactions, customer_events, customers, rate_limits, domain_events restart identity cascade`.execute(
    db,
  );
  await sql`alter sequence customer_code_seq restart with 1`.execute(db);
});

describe("/unete · registro", () => {
  it("sin correo → error claro en el campo correo (el correo es obligatorio desde 0043)", async () => {
    const r = await joinClubAction(null, form({ full_name: "Solo Nombre" }));
    expect(r).toMatchObject({ field: "email", error: expect.stringMatching(/correo/i) });
    // Tampoco basta con el teléfono: el correo es la llave del portal.
    const soloTel = await joinClubAction(
      null,
      form({ full_name: "Solo Teléfono", phone: "6645551111" }),
    );
    expect(soloTel).toMatchObject({ field: "email", error: expect.stringMatching(/correo/i) });
    expect((await sql`select 1 from customers`.execute(db)).rows).toHaveLength(0);
  });

  it("el teléfono pasa a ser opcional: con nombre y correo alcanza", async () => {
    const to = await redirectOf(
      joinClubAction(null, form({ full_name: "Sin Teléfono", email: "sinte@example.com" })),
    );
    expect(to).toMatch(/^\/mi-tarjeta\/.+\?bienvenida=1$/);
    const c = await sql<{
      phone: string | null;
      email: string;
    }>`select phone, email from customers`.execute(db);
    expect(c.rows[0]).toMatchObject({ phone: null, email: "sinte@example.com" });
  });

  it("teléfono inválido y correo inválido se rechazan con su campo", async () => {
    expect(
      await joinClubAction(
        null,
        form({ full_name: "Ana", phone: "12345", email: "ana@example.com" }),
      ),
    ).toMatchObject({ field: "phone" });
    expect(await joinClubAction(null, form({ full_name: "Ana", email: "ana@" }))).toMatchObject({
      field: "email",
    });
  });

  it("alta nueva → redirige a su tarjeta; el correo se guarda en minúsculas y el +52 como 10 dígitos", async () => {
    const to = await redirectOf(
      joinClubAction(
        null,
        form({ full_name: "Nueva Cliente", phone: "+52 664 555 0101", email: "Nueva@Example.COM" }),
      ),
    );
    expect(to).toMatch(/^\/mi-tarjeta\/.+\?bienvenida=1$/);
    const c = await sql<{
      phone: string;
      email: string;
      source: string;
      qr_token: string;
    }>`select phone, email, source, qr_token from customers`.execute(db);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({
      phone: "6645550101",
      email: "nueva@example.com",
      source: "qr",
    });
    expect(decodeURIComponent(to!.split("/")[2]!.split("?")[0]!)).toBe(c.rows[0]!.qr_token);
  });

  it("teléfono ya registrado → NO redirige a la tarjeta ajena, no la modifica y avisa sin revelar nada", async () => {
    await redirectOf(
      joinClubAction(
        null,
        form({ full_name: "Titular Real", phone: "6645550202", email: "titular.real@example.com" }),
      ),
    );
    const before =
      await sql`select full_name, email, birthday, marketing_consent from customers`.execute(db);
    const r = await joinClubAction(
      null,
      form({
        full_name: "Intruso",
        phone: "664 555 0202",
        email: "intruso@example.com",
        birthday: "1990-01-01",
        marketing_consent: "on",
      }),
    );
    expect(r).toMatchObject({ notice: "existing", emailSent: false });
    expect(r && "error" in r ? r.error : undefined).toBeUndefined();
    const after =
      await sql`select full_name, email, birthday, marketing_consent from customers`.execute(db);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(1);
    // Tampoco por correo ya registrado
    await redirectOf(
      joinClubAction(null, form({ full_name: "Con Correo", email: "titular@example.com" })),
    );
    expect(
      await joinClubAction(
        null,
        form({ full_name: "Otro", phone: "6645550303", email: "TITULAR@example.com" }),
      ),
    ).toMatchObject({ notice: "existing" });
    expect((await sql`select 1 from customers`.execute(db)).rows).toHaveLength(2);
  });

  it("rate limit: la 21.ª alta desde la misma IP se rechaza", async () => {
    ip = "198.51.100.21";
    for (let i = 0; i < 20; i++) {
      const to = await redirectOf(
        joinClubAction(
          null,
          form({
            full_name: `P ${i}`,
            phone: `66400000${String(i).padStart(2, "0")}`,
            email: `p${i}@example.com`,
          }),
        ),
      );
      expect(to).toMatch(/^\/mi-tarjeta\//);
    }
    const r = await joinClubAction(
      null,
      form({ full_name: "Bloqueado", phone: "6640009999", email: "bloqueado@example.com" }),
    );
    expect(r).toMatchObject({ error: expect.stringMatching(/demasiados intentos/i) });
  });
});

describe("/mi-tarjeta · resolución del token", () => {
  it("solo el qr_token abre la tarjeta; teléfono, correo y código PDP devuelven null (→ 404)", async () => {
    await redirectOf(
      joinClubAction(
        null,
        form({ full_name: "Ana López Ruiz", phone: "6641234567", email: "ana@example.com" }),
      ),
    );
    const row = (
      await sql<{
        qr_token: string;
        public_code: string;
      }>`select qr_token, public_code from customers`.execute(db)
    ).rows[0]!;
    const byToken = await findCustomerByQrToken(row.qr_token);
    expect(byToken?.fullName).toBe("Ana López Ruiz");
    expect(await findCustomerByQrToken(encodeURIComponent(row.qr_token))).not.toBeNull();
    for (const guess of [
      "6641234567",
      "ana@example.com",
      row.public_code,
      row.public_code.toLowerCase(),
      "",
      "x",
    ]) {
      expect(await findCustomerByQrToken(guess), guess).toBeNull();
    }
    // La búsqueda del POS/checkout sigue resolviendo por teléfono y código (solo en servidor)
    expect((await findCustomer("6641234567"))?.id).toBe(byToken!.id);
    expect((await findCustomer(row.public_code.toLowerCase()))?.id).toBe(byToken!.id);
  });
});
