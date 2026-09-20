/**
 * Portal del cliente (migración 0043) contra Postgres real:
 *  - `register_customer` exige correo, con la excepción documentada `allow_without_email`.
 *  - Normalización (mayúsculas/espacios) y unicidad del correo; el cliente histórico sin correo
 *    lo recibe después SIN duplicarse ni perder puntos, QR ni historial.
 *  - Tokens de acceso: un solo uso, caducidad y que en la base solo vive el sha256.
 *  - Sesiones de cliente: creación, caducidad y revocación (incluida la revocación masiva).
 *  - No regresión: `pos_checkout` / `finalize_sale` siguen dejando el ledger y los totales igual.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  posCheckout,
  sql,
  withStaff,
  callFn,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;
let croissant: string;

/**
 * Alta para estas pruebas. Desde la migración 0045 el alta humana exige también celular y fecha de
 * nacimiento; como aquí lo que se prueba es el PORTAL, se rellenan por defecto. Cuando el caso los
 * fija, o usa la excepción documentada (importación/seeds), se manda exactamente lo que escribe la
 * prueba. La regla de datos obligatorios vive en customer_required_fields.test.ts.
 */
let telSeq = 0;
const register = (p: Record<string, unknown>) => {
  const excepcion = "allow_without_email" in p || "allow_incomplete" in p;
  const payload = excepcion
    ? p
    : { phone: `6647${String(++telSeq).padStart(6, "0")}`, birthday: "1990-06-15", ...p };
  return callFn<{ customer_id: string; public_code: string; qr_token: string; created: boolean }>(
    db,
    "register_customer",
    [JSON.stringify(payload)],
  );
};

const customerRow = (id: string) =>
  sql<{
    email: string | null;
    phone: string | null;
    qr_token: string;
    public_code: string;
    points_balance: number;
    total_orders: number;
  }>`select email, phone, qr_token, public_code, points_balance, total_orders from customers where id = ${id}`
    .execute(db)
    .then((r) => r.rows[0]!);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
  croissant = await createProduct(db, "Croissant", 4500);
  await withStaff(db, staff, (trx) =>
    callFn(trx, "record_production", [croissant, 50, null, null]),
  );
});
afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("register_customer · correo obligatorio", () => {
  it("sin correo falla con un mensaje claro y no crea nada", async () => {
    await expect(register({ full_name: "Sin Correo", phone: "6640000001" })).rejects.toThrow(
      /correo electrónico es obligatorio/i,
    );
    const n = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });

  it("el nombre sigue siendo obligatorio y se comprueba antes que el correo", async () => {
    await expect(register({ full_name: "   ", email: "x@example.com" })).rejects.toThrow(
      /nombre es obligatorio/i,
    );
  });

  it("con la excepción documentada allow_without_email sí da de alta (POS, importación, seeds)", async () => {
    const r = await register({
      full_name: "Mostrador",
      phone: "6640000002",
      allow_without_email: true,
    });
    expect(r.created).toBe(true);
    expect((await customerRow(r.customer_id)).email).toBeNull();
    // También con la excepción hace falta teléfono o correo: no se crean fantasmas.
    await expect(register({ full_name: "Nada", allow_without_email: true })).rejects.toThrow(
      /teléfono o email/i,
    );
  });

  it("normaliza el correo (minúsculas y sin espacios) y deduplica sin importar cómo se escriba", async () => {
    const a = await register({ full_name: "Ana", email: "  ANA@Example.COM  " });
    expect((await customerRow(a.customer_id)).email).toBe("ana@example.com");
    const b = await register({ full_name: "Ana otra vez", email: "Ana@EXAMPLE.com" });
    expect(b).toMatchObject({ customer_id: a.customer_id, created: false });
    const n = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("el índice único del correo se respeta aunque se inserte por fuera; el error es legible", async () => {
    await register({ full_name: "Ana", email: "ana@example.com" });
    await expect(
      sql`insert into customers(full_name, email) values ('Impostora', 'ana@example.com')`.execute(
        db,
      ),
    ).rejects.toThrow();
    // Y por la vía de la función: mismo correo con otro teléfono reutiliza, no duplica.
    const c = await register({
      full_name: "Ana",
      phone: "6640000003",
      email: "ANA@example.com",
    });
    expect(c.created).toBe(false);
  });

  it("cliente histórico sin correo: al registrarlo con correo se completa, no se duplica, y conserva puntos, QR y compras", async () => {
    const legacy = await register({
      full_name: "Histórica",
      phone: "6645550000",
      allow_without_email: true,
    });
    await posCheckout(db, staff, {
      customer_id: legacy.customer_id,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    const before = await customerRow(legacy.customer_id);
    expect(before.email).toBeNull();
    expect(before.points_balance).toBeGreaterThan(0);

    const again = await register({
      full_name: "Histórica",
      phone: "664 555 0000",
      email: "Historica@Example.com",
    });
    expect(again).toMatchObject({ customer_id: legacy.customer_id, created: false });

    const after = await customerRow(legacy.customer_id);
    expect(after.email).toBe("historica@example.com");
    expect(after.qr_token).toBe(before.qr_token); // el QR impreso sigue sirviendo
    expect(after.public_code).toBe(before.public_code);
    expect(after.points_balance).toBe(before.points_balance);
    expect(after.total_orders).toBe(before.total_orders);
    const n = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
    // Y su historial de compras sigue colgando del mismo cliente
    const sales = await sql<{
      n: number;
    }>`select count(*)::int as n from sales where customer_id = ${legacy.customer_id}`.execute(db);
    expect(sales.rows[0]!.n).toBe(1);
  });

  it("el correo también se puede completar desde el CRM con un UPDATE directo, sin tocar el resto", async () => {
    const legacy = await register({
      full_name: "Otra Histórica",
      phone: "6645550001",
      allow_without_email: true,
    });
    await withStaff(db, staff, (trx) =>
      sql`update customers set email = 'otra@example.com' where id = ${legacy.customer_id}`.execute(
        trx,
      ),
    );
    expect((await customerRow(legacy.customer_id)).email).toBe("otra@example.com");
    // Y el índice único impide asignarle a otro cliente el mismo correo.
    const dos = await register({
      full_name: "Distinta",
      phone: "6645550002",
      allow_without_email: true,
    });
    await expect(
      sql`update customers set email = 'otra@example.com' where id = ${dos.customer_id}`.execute(
        db,
      ),
    ).rejects.toThrow();
  });
});

describe("customer_access_tokens · enlace de acceso", () => {
  it("guarda solo el hash, caduca y sirve una sola vez", async () => {
    const c = await register({ full_name: "Ana", email: "ana@example.com" });
    const token = "token-de-prueba-suficientemente-largo";
    await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
              values (${c.customer_id}, ${sha256(token)}, now() + interval '1 hour')`.execute(db);

    // El token en claro no aparece por ningún lado.
    const stored = await sql<{
      token_hash: string;
    }>`select token_hash from customer_access_tokens where customer_id = ${c.customer_id}`.execute(
      db,
    );
    expect(stored.rows[0]!.token_hash).toBe(sha256(token));
    expect(stored.rows[0]!.token_hash).not.toContain(token);

    // Primer canje: lo marca usado y devuelve el cliente.
    const first = await sql<{ customer_id: string }>`
      update customer_access_tokens set used_at = now()
       where token_hash = ${sha256(token)} and used_at is null and expires_at > now()
       returning customer_id`.execute(db);
    expect(first.rows).toHaveLength(1);

    // Segundo canje del MISMO token: cero filas.
    const second = await sql`update customer_access_tokens set used_at = now()
       where token_hash = ${sha256(token)} and used_at is null and expires_at > now()
       returning customer_id`.execute(db);
    expect(second.rows).toHaveLength(0);
  });

  it("un token caducado no se puede canjear", async () => {
    const c = await register({ full_name: "Beto", email: "beto@example.com" });
    await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
              values (${c.customer_id}, ${sha256("viejo")}, now() - interval '1 minute')`.execute(
      db,
    );
    const r = await sql`update customer_access_tokens set used_at = now()
       where token_hash = ${sha256("viejo")} and used_at is null and expires_at > now()
       returning customer_id`.execute(db);
    expect(r.rows).toHaveLength(0);
  });

  it("borrar el cliente arrastra sus tokens (no quedan credenciales huérfanas)", async () => {
    const c = await register({ full_name: "Caro", email: "caro@example.com" });
    await sql`insert into customer_access_tokens(customer_id, token_hash, expires_at)
              values (${c.customer_id}, ${sha256("t")}, now() + interval '1 hour')`.execute(db);
    await sql`delete from customers where id = ${c.customer_id}`.execute(db);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from customer_access_tokens`.execute(db);
    expect(n.rows[0]!.n).toBe(0);
  });
});

describe("customer_sessions · sesiones del cliente", () => {
  const live = (customerId: string, tokenHash: string) =>
    sql<{ n: number }>`select count(*)::int as n from customer_sessions
        where customer_id = ${customerId} and token_hash = ${tokenHash}
          and revoked_at is null and expires_at > now()`
      .execute(db)
      .then((r) => r.rows[0]!.n);

  it("se crea con el hash del token, caduca y se revoca", async () => {
    const c = await register({ full_name: "Ana", email: "ana@example.com" });
    const th = sha256("sesion-1");
    await sql`insert into customer_sessions(customer_id, token_hash, expires_at)
              values (${c.customer_id}, ${th}, now() + interval '30 days')`.execute(db);
    expect(await live(c.customer_id, th)).toBe(1);

    // Caducada: deja de contar como viva.
    await sql`update customer_sessions set expires_at = now() - interval '1 second' where token_hash = ${th}`.execute(
      db,
    );
    expect(await live(c.customer_id, th)).toBe(0);

    // Revocada (cerrar sesión): tampoco.
    await sql`update customer_sessions set expires_at = now() + interval '30 days', revoked_at = now() where token_hash = ${th}`.execute(
      db,
    );
    expect(await live(c.customer_id, th)).toBe(0);
  });

  it("dos sesiones del mismo cliente conviven y la revocación masiva las cierra todas", async () => {
    const c = await register({ full_name: "Ana", email: "ana@example.com" });
    for (const t of ["movil", "compu"]) {
      await sql`insert into customer_sessions(customer_id, token_hash, expires_at)
                values (${c.customer_id}, ${sha256(t)}, now() + interval '30 days')`.execute(db);
    }
    expect(await live(c.customer_id, sha256("movil"))).toBe(1);
    expect(await live(c.customer_id, sha256("compu"))).toBe(1);
    await sql`update customer_sessions set revoked_at = now() where customer_id = ${c.customer_id} and revoked_at is null`.execute(
      db,
    );
    expect(await live(c.customer_id, sha256("movil"))).toBe(0);
    expect(await live(c.customer_id, sha256("compu"))).toBe(0);
  });

  it("el token_hash es único: el mismo token no puede abrir dos sesiones", async () => {
    const c = await register({ full_name: "Ana", email: "ana@example.com" });
    await sql`insert into customer_sessions(customer_id, token_hash, expires_at)
              values (${c.customer_id}, ${sha256("repetido")}, now() + interval '30 days')`.execute(
      db,
    );
    await expect(
      sql`insert into customer_sessions(customer_id, token_hash, expires_at)
          values (${c.customer_id}, ${sha256("repetido")}, now() + interval '30 days')`.execute(db),
    ).rejects.toThrow();
  });
});

describe("no regresión · ledger y totales tras el cambio de register_customer", () => {
  it("pos_checkout sigue sumando puntos, actualizando estadísticas y dejando el ledger cuadrado", async () => {
    const c = await createCustomer(db, "Ana López", "6641234567", "ana@example.com");
    const r1 = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 2 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 9000 }],
    });
    expect(r1.folio).toMatch(/^PDP-\d{4}-\d{6}$/);
    const after1 = await customerRow(c.customer_id);
    expect(after1.points_balance).toBe(9); // 9000 centavos / 1000 × 1 punto
    expect(after1.total_orders).toBe(1);

    const r2 = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    expect(r2.folio).not.toBe(r1.folio);
    const after2 = await customerRow(c.customer_id);
    expect(after2.points_balance).toBe(13);
    expect(after2.total_orders).toBe(2);

    // El ledger cuadra con el saldo y cada movimiento apunta a su venta.
    const ledger = await sql<{
      points: number;
      balance_after: number;
      sale_id: string | null;
    }>`select points, balance_after, sale_id from loyalty_transactions
        where customer_id = ${c.customer_id} order by id`.execute(db);
    expect(ledger.rows.map((x) => x.points)).toEqual([9, 4]);
    expect(ledger.rows.at(-1)!.balance_after).toBe(after2.points_balance);
    expect(ledger.rows.every((x) => x.sale_id !== null)).toBe(true);

    // Y los totales de ventas coinciden con lo gastado por el cliente.
    const totals = await sql<{ suma: number; n: number }>`
      select coalesce(sum(total_cents), 0)::int as suma, count(*)::int as n
        from sales where customer_id = ${c.customer_id} and voided_at is null`.execute(db);
    expect(totals.rows[0]).toEqual({ suma: 13500, n: 2 });
    const spent = await sql<{
      total_spent_cents: number;
    }>`select total_spent_cents from customers where id = ${c.customer_id}`.execute(db);
    expect(Number(spent.rows[0]!.total_spent_cents)).toBe(13500);
  });

  it("una venta anulada se marca como tal sin borrarse (el portal la muestra cancelada)", async () => {
    const c = await createCustomer(db, "Ana López", "6641234567", "ana@example.com");
    const r = await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    const sale = await sql<{
      id: string;
    }>`select s.id from sales s join orders o on o.id = s.order_id where o.folio = ${r.folio as string}`.execute(
      db,
    );
    await withStaff(db, staff, (trx) =>
      callFn(trx, "void_sale", [sale.rows[0]!.id, "Prueba de anulación"]),
    );
    const after = await sql<{
      voided: boolean;
    }>`select (voided_at is not null) as voided from sales where id = ${sale.rows[0]!.id}`.execute(
      db,
    );
    expect(after.rows[0]!.voided).toBe(true);
  });
});
