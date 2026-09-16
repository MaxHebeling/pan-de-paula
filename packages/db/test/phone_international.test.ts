/**
 * Teléfonos internacionales (0044_phone_international.sql).
 *
 * Regla de almacenamiento: México sigue guardándose con 10 dígitos pelados y el resto del mundo en
 * E.164 ("+16195550100"). Esta suite fija que un cliente extranjero se puede dar de alta, no se
 * duplica, se encuentra escribiendo el número CON y SIN "+", y que un cliente mexicano existente se
 * sigue encontrando exactamente igual que antes.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parsePhone, phoneToE164Digits, PHONE_COUNTRIES } from "@pdp/domain";
import { testDb, truncateAll, createStaff, sql, withStaff, callFn } from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;

beforeEach(async () => {
  await truncateAll(db);
  staff = await createStaff(db);
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

function asStaff<T>(fn: string, args: unknown[]) {
  return withStaff(db, staff, (trx) => callFn<T>(trx, fn, args));
}

const register = (payload: Record<string, unknown>) =>
  asStaff<{ customer_id: string; public_code: string; created: boolean }>("register_customer", [
    JSON.stringify({ allow_without_email: true, ...payload }),
  ]);

const phoneOf = async (id: string) =>
  (
    await sql<{
      phone: string | null;
    }>`select phone::text as phone from customers where id = ${id}`.execute(db)
  ).rows[0]!.phone;

const findOne = async (q: string) =>
  (await sql<{ full_name: string }>`select full_name from find_customer(${q})`.execute(db)).rows[0]
    ?.full_name ?? null;

describe("normalize_phone_digits", () => {
  it("da la misma forma comparable escriba quien escriba el número con o sin +", async () => {
    const r = await sql<Record<string, string | null>>`
      select normalize_phone_digits('+1 (619) 555-0100') a,
             normalize_phone_digits('1 619 555 0100')    b,
             normalize_phone_digits('+52 664 123 4567')  c,
             normalize_phone_digits('6641234567')        d,
             normalize_phone_digits('+506 8312 3456')    e,
             normalize_phone_digits('50683123456')       f,
             normalize_phone_digits('  ')                g`.execute(db);
    expect(r.rows[0]).toEqual({
      a: "16195550100",
      b: "16195550100",
      c: "6641234567",
      d: "6641234567",
      e: "50683123456",
      f: "50683123456",
      g: null,
    });
  });

  it("es estable para el valor canónico de cada país del catálogo", async () => {
    // La forma comparable es el valor guardado sin el "+": México 10 dígitos, el resto E.164.
    for (const c of PHONE_COUNTRIES) {
      const parsed = parsePhone(c.iso, c.example);
      expect(parsed.ok, c.iso).toBe(true);
      if (!parsed.ok) continue;
      const r = await sql<{ d: string | null; e: string | null }>`
        select normalize_phone_digits(${parsed.value}) as d,
               normalize_phone_digits(${parsed.value.replace("+", "")}) as e`.execute(db);
      expect(r.rows[0]!.d, c.iso).toBe(parsed.value.replace("+", ""));
      expect(r.rows[0]!.e, `${c.iso} sin +`).toBe(parsed.value.replace("+", ""));
    }
  });

  it("el enlace de WhatsApp del dominio marca siempre con prefijo de país", () => {
    for (const c of PHONE_COUNTRIES) {
      const parsed = parsePhone(c.iso, c.example);
      if (!parsed.ok) continue;
      expect(phoneToE164Digits(parsed.value), c.iso).toBe(
        `${c.dial}${parsed.value.replace(/^\+/, "").replace(new RegExp(`^${c.dial}`), "")}`,
      );
    }
  });
});

describe("alta de cliente con número extranjero", () => {
  it("se guarda en E.164 y no se duplica al repetirlo con otra escritura", async () => {
    const a = await register({ full_name: "Sandra San Diego", phone: "+1 619 555 0100" });
    expect(a.created).toBe(true);
    expect(await phoneOf(a.customer_id)).toBe("+16195550100");

    // Mismo número escrito sin "+" y con separadores: es el mismo cliente, no uno nuevo.
    for (const raw of ["1 619 555 0100", "+1 (619) 555-0100", "+16195550100"]) {
      const again = await register({ full_name: "Sandra dup", phone: raw });
      expect(again, raw).toMatchObject({ customer_id: a.customer_id, created: false });
    }
    const n = await sql<{ n: number }>`select count(*)::int n from customers`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("el índice único impide dos clientes con el mismo teléfono extranjero", async () => {
    await register({ full_name: "Sandra", phone: "+1 619 555 0100" });
    await expect(
      sql`insert into customers(full_name, phone) values ('Otra', '+16195550100')`.execute(db),
    ).rejects.toThrow(/customers_phone_idx|duplicate key/);
  });

  it("dos países distintos con el mismo número nacional son dos clientes", async () => {
    const mx = await register({ full_name: "Cliente MX", phone: "6641234567" });
    const es = await register({ full_name: "Cliente ES", phone: "+34 664 123 456" });
    expect(es.created).toBe(true);
    expect(es.customer_id).not.toBe(mx.customer_id);
    expect(await phoneOf(es.customer_id)).toBe("+34664123456");
  });
});

describe("find_customer con números extranjeros", () => {
  it("encuentra al cliente extranjero con y sin +, con espacios y guiones", async () => {
    await register({ full_name: "Sandra San Diego", phone: "+1 619 555 0100" });
    for (const q of [
      "+16195550100",
      "16195550100",
      "+1 619 555 0100",
      "1 (619) 555-0100",
      "1-619-555-0100",
    ]) {
      expect(await findOne(q), q).toBe("Sandra San Diego");
    }
  });

  it("funciona para todos los países del catálogo, con y sin +", async () => {
    for (const c of PHONE_COUNTRIES) {
      if (c.iso === "MX") continue;
      await truncateAll(db);
      staff = await createStaff(db);
      const parsed = parsePhone(c.iso, c.example);
      expect(parsed.ok, c.iso).toBe(true);
      if (!parsed.ok) continue;
      await register({ full_name: `Cliente ${c.iso}`, phone: parsed.value });
      expect(await findOne(parsed.value), `${c.iso} con +`).toBe(`Cliente ${c.iso}`);
      expect(await findOne(parsed.value.replace("+", "")), `${c.iso} sin +`).toBe(
        `Cliente ${c.iso}`,
      );
    }
  });

  it("un cliente mexicano existente se sigue encontrando igual que antes", async () => {
    // Registro "histórico": exactamente como está hoy en producción, 10 dígitos pelados.
    await sql`insert into customers(full_name, phone) values ('Paula Histórica', '6649998877')`.execute(
      db,
    );
    for (const q of [
      "6649998877",
      "664 999 8877",
      "(664) 999-8877",
      "+52 664 999 8877",
      "52 664 999 8877",
      "+52 1 664 999 8877",
      "01 664 999 8877",
    ]) {
      expect(await findOne(q), q).toBe("Paula Histórica");
    }
    // Y no se confunde con nadie más.
    expect(await findOne("6195550100")).toBeNull();
    expect(await findOne("12")).toBeNull();
  });

  it("sigue encontrando por QR, código público y correo", async () => {
    const r = await register({ full_name: "Sandra", phone: "+1 619 555 0100" });
    const row = await sql<{ qr_token: string; public_code: string }>`
      select qr_token, public_code from customers where id = ${r.customer_id}`.execute(db);
    expect(await findOne(row.rows[0]!.qr_token)).toBe("Sandra");
    expect(await findOne(row.rows[0]!.public_code.toLowerCase())).toBe("Sandra");
  });
});
