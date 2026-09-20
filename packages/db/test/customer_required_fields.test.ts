/**
 * Alta de cliente con datos completos (migración 0045) contra Postgres real.
 *
 * Lo que se prueba es la REGLA donde vive —`register_customer`—, no la pantalla: así la cumplen por
 * igual el mostrador, el sitio y el CRM. Y se prueba lo contrario con la misma fuerza: un cliente
 * histórico incompleto no se rompe, no se duplica y conserva su código, su QR, sus puntos y su historial.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  posCheckout,
  sql,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let pan: string;

const register = (p: Record<string, unknown>) =>
  callFn<{ customer_id: string; public_code: string; qr_token: string; created: boolean }>(
    db,
    "register_customer",
    [JSON.stringify(p)],
  );

const completo = {
  full_name: "Rosa Méndez",
  phone: "6641230001",
  email: "rosa@correo.com",
  birthday: "1990-03-21",
  source: "web",
};

const row = (id: string) =>
  sql<{
    email: string | null;
    phone: string | null;
    birthday: string | null;
    public_code: string;
    qr_token: string;
    points_balance: number;
    total_orders: number;
  }>`select email::text as email, phone::text as phone, to_char(birthday,'YYYY-MM-DD') as birthday,
            public_code, qr_token, points_balance, total_orders
       from customers where id = ${id}`
    .execute(db)
    .then((r) => r.rows[0]!);

const missing = (id: string) =>
  sql<{ f: string[] }>`select customer_missing_fields(${id}::uuid) as f`
    .execute(db)
    .then((r) => r.rows[0]!.f);

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  pan = await createProduct(db, "Concha", 2500);
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("alta de cliente: datos obligatorios", () => {
  it("rechaza el alta sin celular, sin correo o sin fecha de nacimiento", async () => {
    await expect(register({ ...completo, phone: "" })).rejects.toThrow(/celular es obligatorio/i);
    await expect(register({ ...completo, email: "" })).rejects.toThrow(/correo.*obligatorio/i);
    await expect(register({ ...completo, birthday: "" })).rejects.toThrow(
      /fecha de nacimiento es obligatoria/i,
    );
    await expect(register({ ...completo, full_name: "   " })).rejects.toThrow(
      /nombre es obligatorio/i,
    );
    const n = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(0); // ninguno de los rechazos dejó a medias un cliente
  });

  it("rechaza una fecha de nacimiento futura o imposible, venga de donde venga", async () => {
    const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await expect(register({ ...completo, birthday: manana })).rejects.toThrow(
      /no puede ser futura/i,
    );
    await expect(register({ ...completo, birthday: "1899-12-31" })).rejects.toThrow(
      /Revisa la fecha/i,
    );
    // La excepción de importación NO es una puerta trasera para fechas imposibles.
    await expect(
      register({ ...completo, birthday: manana, allow_incomplete: true }),
    ).rejects.toThrow(/no puede ser futura/i);
  });

  it("acepta el alta completa y normaliza el correo", async () => {
    const r = await register({ ...completo, email: "  Rosa@Correo.COM " });
    expect(r.created).toBe(true);
    const c = await row(r.customer_id);
    expect(c).toMatchObject({
      email: "rosa@correo.com",
      phone: "6641230001",
      birthday: "1990-03-21",
    });
    expect(await missing(r.customer_id)).toEqual([]);
    // El mismo correo con otras mayúsculas es el MISMO cliente, no uno nuevo.
    const otra = await register({ ...completo, email: "ROSA@correo.com", phone: "6649999999" });
    expect(otra.created).toBe(false);
    expect(otra.customer_id).toBe(r.customer_id);
  });

  it("la excepción documentada sigue sirviendo para importación, seeds y pruebas", async () => {
    const r = await register({
      full_name: "Cliente histórico",
      phone: "6645550000",
      allow_incomplete: true,
    });
    expect(r.created).toBe(true);
    expect(await missing(r.customer_id)).toEqual(expect.arrayContaining(["email", "birthday"]));
    // Alias antiguo (`allow_without_email`), que ya usan el importador y los seeds.
    const r2 = await register({
      full_name: "Otro histórico",
      phone: "6645550001",
      allow_without_email: true,
    });
    expect(r2.created).toBe(true);
  });
});

describe("clientes históricos incompletos", () => {
  it("se completan sin duplicarse y conservan código, QR, puntos y compras", async () => {
    const viejo = await register({
      full_name: "Karla Histórica",
      phone: "3335598792",
      allow_incomplete: true,
    });
    const antes = await row(viejo.customer_id);
    await posCheckout(db, staff, {
      items: [{ product_id: pan, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 5000, tendered_cents: 5000 }],
      customer_id: viejo.customer_id,
    });
    const conCompra = await row(viejo.customer_id);
    expect(conCompra.total_orders).toBe(1);

    // Llega su correo y su fecha: el MISMO registro se completa.
    const otra = await register({
      full_name: "Karla Histórica",
      phone: "3335598792",
      email: "karla@correo.com",
      birthday: "1998-12-25",
    });
    expect(otra.created).toBe(false);
    expect(otra.customer_id).toBe(viejo.customer_id);

    const despues = await row(viejo.customer_id);
    expect(despues.email).toBe("karla@correo.com");
    expect(despues.birthday).toBe("1998-12-25");
    expect(despues.public_code).toBe(antes.public_code);
    expect(despues.qr_token).toBe(antes.qr_token);
    expect(despues.points_balance).toBe(conCompra.points_balance);
    expect(despues.total_orders).toBe(1);
    expect(await missing(viejo.customer_id)).toEqual([]);
    const n = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(1); // no se creó un segundo registro
  });

  it("un dato que ya existe no se pisa con otro distinto", async () => {
    const c = await register(completo);
    await register({ ...completo, birthday: "1985-01-01", full_name: "Rosa M." });
    expect((await row(c.customer_id)).birthday).toBe("1990-03-21");
  });

  it("customer_missing_fields enumera solo lo que falta", async () => {
    const c = await register({
      full_name: "Media ficha",
      email: "media@correo.com",
      allow_incomplete: true,
    });
    expect((await missing(c.customer_id)).sort()).toEqual(["birthday", "phone"]);
  });
});
