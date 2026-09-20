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
  it("el alta pide los cuatro datos y dice cuál falta (migración 0045)", async () => {
    const soloNombre = await joinClubAction(null, form({ full_name: "Solo Nombre" }));
    expect(soloNombre).toMatchObject({ field: "phone", error: expect.stringMatching(/celular/i) });
    const sinCorreo = await joinClubAction(
      null,
      form({ full_name: "Solo Teléfono", phone: "6645551111" }),
    );
    expect(sinCorreo).toMatchObject({ field: "email", error: expect.stringMatching(/correo/i) });
    const sinFecha = await joinClubAction(
      null,
      form({ full_name: "Sin Fecha", phone: "6645551111", email: "sinfecha@example.com" }),
    );
    expect(sinFecha).toMatchObject({
      field: "birthday",
      error: expect.stringMatching(/fecha de nacimiento/i),
    });
    // Ninguno de los rechazos dejó un cliente a medias.
    expect((await sql`select 1 from customers`.execute(db)).rows).toHaveLength(0);
  });

  it("una fecha de nacimiento futura se rechaza aunque el navegador la deje escribir", async () => {
    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await joinClubAction(
      null,
      form({
        full_name: "Del Futuro",
        phone: "6645551122",
        email: "futuro@example.com",
        birthday: manana,
      }),
    );
    expect(r).toMatchObject({ field: "birthday", error: expect.stringMatching(/futura/i) });
    expect((await sql`select 1 from customers`.execute(db)).rows).toHaveLength(0);
  });

  it("teléfono inválido y correo inválido se rechazan con su campo", async () => {
    expect(
      await joinClubAction(
        null,
        form({
          full_name: "Ana",
          phone: "12345",
          email: "ana@example.com",
          birthday: "1990-01-01",
        }),
      ),
    ).toMatchObject({ field: "phone" });
    expect(
      await joinClubAction(
        null,
        form({ full_name: "Ana", phone: "6645550909", email: "ana@", birthday: "1990-01-01" }),
      ),
    ).toMatchObject({ field: "email" });
  });

  it("alta nueva → redirige a su tarjeta; el correo se guarda en minúsculas y el +52 como 10 dígitos", async () => {
    const to = await redirectOf(
      joinClubAction(
        null,
        form({
          full_name: "Nueva Cliente",
          phone: "+52 664 555 0101",
          email: "Nueva@Example.COM",
          birthday: "1990-06-15",
        }),
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

  it("país del selector: el teléfono extranjero se guarda en E.164 y el mexicano con 10 dígitos", async () => {
    const to = await redirectOf(
      joinClubAction(
        null,
        form({
          full_name: "Sandra San Diego",
          phone_country: "US",
          phone: "619 555 0100",
          email: "sandra@example.com",
          birthday: "1990-06-15",
        }),
      ),
    );
    expect(to).toMatch(/^\/mi-tarjeta\/.+\?bienvenida=1$/);
    const c = await sql<{ phone: string }>`select phone from customers`.execute(db);
    expect(c.rows[0]!.phone).toBe("+16195550100");
    // Y se encuentra escribiéndolo con o sin "+" (find_customer, migración 0044).
    expect((await findCustomer("+16195550100"))?.fullName).toBe("Sandra San Diego");
    expect((await findCustomer("16195550100"))?.fullName).toBe("Sandra San Diego");
  });

  it("longitud equivocada para el país elegido → error en español en el campo teléfono", async () => {
    const r = await joinClubAction(
      null,
      form({
        full_name: "Sandra",
        phone_country: "US",
        phone: "619 555 010",
        email: "sandra2@example.com",
        birthday: "1990-06-15",
      }),
    );
    expect(r).toMatchObject({ field: "phone" });
    expect(r?.error).toContain("Estados Unidos");
    // El formulario se repuebla con el país elegido para no obligar a volver a escogerlo.
    expect(r?.values?.phone_country).toBe("US");
    const n = await sql<{ n: number }>`select count(*)::int n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("país desconocido → el servidor cae a México en vez de confiar en el navegador", async () => {
    await redirectOf(
      joinClubAction(
        null,
        form({
          full_name: "Ana",
          phone_country: "no-existe",
          phone: "664 555 0102",
          email: "ana3@example.com",
          birthday: "1990-06-15",
        }),
      ),
    );
    const c = await sql<{ phone: string }>`select phone from customers`.execute(db);
    expect(c.rows[0]!.phone).toBe("6645550102");
  });

  it("teléfono ya registrado → NO redirige a la tarjeta ajena, no la modifica y avisa sin revelar nada", async () => {
    await redirectOf(
      joinClubAction(
        null,
        form({
          full_name: "Titular Real",
          phone: "6645550202",
          email: "titular.real@example.com",
          birthday: "1990-06-15",
        }),
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
      joinClubAction(
        null,
        form({
          full_name: "Con Correo",
          phone: "6645550404",
          email: "titular@example.com",
          birthday: "1990-06-15",
        }),
      ),
    );
    expect(
      await joinClubAction(
        null,
        form({
          full_name: "Otro",
          phone: "6645550303",
          email: "TITULAR@example.com",
          birthday: "1990-06-15",
        }),
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
            birthday: "1990-06-15",
          }),
        ),
      );
      expect(to).toMatch(/^\/mi-tarjeta\//);
    }
    const r = await joinClubAction(
      null,
      form({
        full_name: "Bloqueado",
        phone: "6640009999",
        email: "bloqueado@example.com",
        birthday: "1990-06-15",
      }),
    );
    expect(r).toMatchObject({ error: expect.stringMatching(/demasiados intentos/i) });
  });
});

describe("/mi-tarjeta · resolución del token", () => {
  it("solo el qr_token abre la tarjeta; teléfono, correo y código PDP devuelven null (→ 404)", async () => {
    await redirectOf(
      joinClubAction(
        null,
        form({
          full_name: "Ana López Ruiz",
          phone: "6641234567",
          email: "ana@example.com",
          birthday: "1990-06-15",
        }),
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
