import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  testDb,
  truncateAll,
  createStaff,
  createProduct,
  createCustomer,
  posCheckout,
  sql,
  callFn,
  withStaff,
} from "./helpers.ts";

const { db, pool } = testDb();
let staff: string;

beforeEach(async () => {
  await truncateAll(db);
  await sql`update business_settings set timezone = 'America/Tijuana' where id = 1`.execute(db);
  staff = await createStaff(db);
});
afterAll(async () => {
  await sql`update business_settings set timezone = 'America/Tijuana' where id = 1`
    .execute(db)
    .catch(() => {});
  await db.destroy();
  await pool.end().catch(() => {});
});

/** Fecha local del negocio (la misma que usa run_customer_events por defecto). */
const todayLocal = () =>
  sql<{
    d: string;
  }>`select (now() at time zone (select timezone from business_settings where id = 1))::date::text as d`
    .execute(db)
    .then((r) => r.rows[0]!.d);

/**
 * Cumpleaños desplazado 28 años (múltiplo de 4: si la fecha base es un 29 de febrero el resultado
 * sigue cayendo en año bisiesto y no se desplaza al 28).
 */
async function setBirthdayFrom(customerId: string, baseDate: string) {
  await sql`update customers set birthday = (${baseDate}::date - interval '28 years')::date where id = ${customerId}`.execute(
    db,
  );
}

const birthdayEvents = () =>
  sql<{ customer_id: string; payload: Record<string, unknown> }>`
    select customer_id, payload from customer_events where kind = 'birthday'`
    .execute(db)
    .then((r) => r.rows);

const clearEvents = async () => {
  await sql`delete from customer_events`.execute(db);
  await sql`delete from notifications`.execute(db);
};

describe("celebrates_birthday_on / birthday_age_on", () => {
  it("coincide en la fecha exacta y no en los días vecinos", async () => {
    const r = await sql<{ exacto: boolean; antes: boolean; despues: boolean }>`
      select celebrates_birthday_on('1990-05-04','2027-05-04') as exacto,
             celebrates_birthday_on('1990-05-04','2027-05-03') as antes,
             celebrates_birthday_on('1990-05-04','2027-05-05') as despues`.execute(db);
    expect(r.rows[0]).toEqual({ exacto: true, antes: false, despues: false });
  });

  it("29 de febrero: fecha exacta en año bisiesto, 28 de febrero en año NO bisiesto", async () => {
    const r = await sql<{
      bis29: boolean;
      bis28: boolean;
      nobis28: boolean;
      nobis0301: boolean;
      siglo28: boolean;
    }>`
      select celebrates_birthday_on('2000-02-29','2024-02-29') as bis29,
             celebrates_birthday_on('2000-02-29','2024-02-28') as bis28,
             celebrates_birthday_on('2000-02-29','2027-02-28') as nobis28,
             celebrates_birthday_on('2000-02-29','2027-03-01') as nobis0301,
             -- 2100 no es bisiesto (divisible entre 100 y no entre 400): se observa el 28
             celebrates_birthday_on('2000-02-29','2100-02-28') as siglo28`.execute(db);
    expect(r.rows[0]).toEqual({
      bis29: true,
      bis28: false,
      nobis28: true,
      nobis0301: false,
      siglo28: true,
    });
  });

  it("quien nació el 28 de febrero celebra el 28 en cualquier año", async () => {
    const r = await sql<{ bis: boolean; nobis: boolean; bis29: boolean }>`
      select celebrates_birthday_on('1990-02-28','2024-02-28') as bis,
             celebrates_birthday_on('1990-02-28','2027-02-28') as nobis,
             celebrates_birthday_on('1990-02-28','2024-02-29') as bis29`.execute(db);
    expect(r.rows[0]).toEqual({ bis: true, nobis: true, bis29: false });
  });

  it("la edad observada del 29 de febrero es la diferencia de años, no age()", async () => {
    const r = await sql<{ bisiesto: number; no_bisiesto: number; normal: number }>`
      select birthday_age_on('2000-02-29','2024-02-29') as bisiesto,
             birthday_age_on('2000-02-29','2027-02-28') as no_bisiesto,
             birthday_age_on('1990-05-04','2027-05-04') as normal`.execute(db);
    // age('2027-02-28','2000-02-29') = 26 años 11 meses: el 28 se celebra el 27º cumpleaños.
    expect(r.rows[0]).toEqual({ bisiesto: 24, no_bisiesto: 27, normal: 37 });
  });
});

describe("run_customer_events · detección de cumpleaños", () => {
  it("detecta solo a quien cumple hoy (no al de mañana ni al de la semana pasada)", async () => {
    const hoy = await todayLocal();
    const a = await createCustomer(db, "Cumple Hoy", "6640000101");
    const b = await createCustomer(db, "Cumple Futuro", "6640000102");
    const c = await createCustomer(db, "Cumple Pasado", "6640000103");
    const d = await createCustomer(db, "Sin Fecha", "6640000104");
    await setBirthdayFrom(a.customer_id, hoy);
    await sql`update customers set birthday = (${hoy}::date + interval '5 days' - interval '28 years')::date where id = ${b.customer_id}`.execute(
      db,
    );
    await sql`update customers set birthday = (${hoy}::date - interval '5 days' - interval '28 years')::date where id = ${c.customer_id}`.execute(
      db,
    );

    const r = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r.birthday).toBe(1);
    const ev = await birthdayEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.customer_id).toBe(a.customer_id);
    expect(ev[0]!.payload.age).toBe(28);
    // El cliente sin fecha de nacimiento nunca genera evento
    expect(ev.some((e) => e.customer_id === d.customer_id)).toBe(false);
  });

  it("corridas repetidas el mismo día no duplican el evento ni la notificación", async () => {
    const hoy = await todayLocal();
    const a = await createCustomer(db, "Cumple Hoy", "6640000105");
    await setBirthdayFrom(a.customer_id, hoy);
    const r1 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    const r2 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    const r3 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect([r1.birthday, r2.birthday, r3.birthday]).toEqual([1, 0, 0]);
    expect(await birthdayEvents()).toHaveLength(1);
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind = 'birthday'`.execute(db);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("ignora clientes eliminados y fusionados", async () => {
    const hoy = await todayLocal();
    const a = await createCustomer(db, "Eliminado", "6640000106");
    const b = await createCustomer(db, "Fusionado", "6640000107");
    const c = await createCustomer(db, "Activo", "6640000108");
    for (const x of [a, b, c]) await setBirthdayFrom(x.customer_id, hoy);
    await sql`update customers set deleted_at = now() where id = ${a.customer_id}`.execute(db);
    await sql`update customers set merged_into_id = ${c.customer_id} where id = ${b.customer_id}`.execute(
      db,
    );
    const r = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r.birthday).toBe(1);
    expect((await birthdayEvents())[0]!.customer_id).toBe(c.customer_id);
  });

  it("29 de febrero: se celebra el 29 en año bisiesto y el 28 en año no bisiesto (una sola vez)", async () => {
    const a = await createCustomer(db, "Bisiesta", "6640000109");
    await sql`update customers set birthday = '2000-02-29' where id = ${a.customer_id}`.execute(db);

    // Año bisiesto: el 28 no dispara, el 29 sí.
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2024-02-28"])).birthday,
    ).toBe(0);
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2024-02-29"])).birthday,
    ).toBe(1);
    let ev = await birthdayEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload.age).toBe(24);
    expect(ev[0]!.payload.observed_rule).toBeUndefined();
    await clearEvents();

    // Año NO bisiesto: se observa el 28; ni el 27 ni el 1 de marzo disparan.
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2027-02-27"])).birthday,
    ).toBe(0);
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2027-02-28"])).birthday,
    ).toBe(1);
    ev = await birthdayEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload.age).toBe(27);
    expect(ev[0]!.payload.observed_rule).toBe("feb29_on_feb28");
    await clearEvents();
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2027-03-01"])).birthday,
    ).toBe(0);
  });

  it("quien nació el 28 de febrero no pierde su cumpleaños en año bisiesto", async () => {
    const a = await createCustomer(db, "Veintiocho", "6640000110");
    await sql`update customers set birthday = '1996-02-28' where id = ${a.customer_id}`.execute(db);
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2024-02-28"])).birthday,
    ).toBe(1);
    await clearEvents();
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2024-02-29"])).birthday,
    ).toBe(0);
  });

  it("usa la fecha local del negocio, no la UTC", async () => {
    // Kiritimati (UTC+14) y Midway (UTC-11) están a 25 h: su fecha local SIEMPRE difiere.
    const z = await sql<{ este: string; oeste: string }>`
      select (now() at time zone 'Pacific/Kiritimati')::date::text as este,
             (now() at time zone 'Pacific/Midway')::date::text as oeste`.execute(db);
    const { este, oeste } = z.rows[0]!;
    expect(este).not.toBe(oeste);

    const a = await createCustomer(db, "Cumple Este", "6640000111");
    const b = await createCustomer(db, "Cumple Oeste", "6640000112");
    await setBirthdayFrom(a.customer_id, este);
    await setBirthdayFrom(b.customer_id, oeste);

    await sql`update business_settings set timezone = 'Pacific/Kiritimati' where id = 1`.execute(
      db,
    );
    const r1 = await callFn<Record<string, unknown>>(db, "run_customer_events", [null]);
    expect(r1.date).toBe(este);
    expect(r1.birthday).toBe(1);
    expect((await birthdayEvents())[0]!.customer_id).toBe(a.customer_id);
    await clearEvents();

    await sql`update business_settings set timezone = 'Pacific/Midway' where id = 1`.execute(db);
    const r2 = await callFn<Record<string, unknown>>(db, "run_customer_events", [null]);
    expect(r2.date).toBe(oeste);
    expect(r2.birthday).toBe(1);
    expect((await birthdayEvents())[0]!.customer_id).toBe(b.customer_id);
  });

  it("cambio de año: el mismo cliente vuelve a celebrar el año siguiente", async () => {
    const a = await createCustomer(db, "Cada Año", "6640000113");
    await sql`update customers set birthday = '1990-07-15' where id = ${a.customer_id}`.execute(db);
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2026-07-15"])).birthday,
    ).toBe(1);
    // El índice único diario de customer_events es por día real de inserción: se envejece el evento
    // para simular que la corrida anterior ocurrió el año pasado.
    await sql`update customer_events set created_at = created_at - interval '1 year' where kind = 'birthday'`.execute(
      db,
    );
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", ["2027-07-15"])).birthday,
    ).toBe(1);
    const ev = await birthdayEvents();
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.payload.age).sort()).toEqual([36, 37]);
  });
});

describe("run_customer_events · sin regresiones en los demás eventos", () => {
  it("inactividad 30/60 y aniversario siguen comportándose igual que antes", async () => {
    const croissant = await createProduct(db, "Croissant", 4500);
    await withStaff(db, staff, (trx) =>
      callFn(trx, "record_production", [croissant, 20, null, null]),
    );
    const c = await createCustomer(db, "Inactivo", "6640000201");
    await posCheckout(db, staff, {
      customer_id: c.customer_id,
      items: [{ product_id: croissant, qty: 1 }],
      payments: [{ provider: "cash", method: "cash", amount_cents: 4500 }],
    });
    await sql`update customers set last_purchase_at = now() - interval '31 days' where id = ${c.customer_id}`.execute(
      db,
    );
    const r1 = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r1.inactive_30).toBe(1);
    expect(r1.inactive_60).toBe(0);
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", [null])).inactive_30,
    ).toBe(0);

    await sql`update customers set last_purchase_at = now() - interval '61 days' where id = ${c.customer_id}`.execute(
      db,
    );
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", [null])).inactive_60,
    ).toBe(1);

    const a = await createCustomer(db, "Aniversario", "6640000202");
    await sql`update customers set created_at = now() - interval '1 year' where id = ${a.customer_id}`.execute(
      db,
    );
    const r = await callFn<Record<string, number>>(db, "run_customer_events", [null]);
    expect(r.anniversary).toBe(1);
    // Segunda corrida el mismo día local: no duplica (guarda de 0041)
    expect(
      (await callFn<Record<string, number>>(db, "run_customer_events", [null])).anniversary,
    ).toBe(0);

    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from notifications where kind in ('inactive_customers','anniversary')`.execute(
      db,
    );
    expect(n.rows[0]!.n).toBe(3);
  });

  it("devuelve el mismo contrato jsonb que antes", async () => {
    const r = await callFn<Record<string, unknown>>(db, "run_customer_events", [null]);
    expect(Object.keys(r).sort()).toEqual([
      "anniversary",
      "birthday",
      "date",
      "inactive_30",
      "inactive_60",
    ]);
  });
});

describe("birthday_greetings", () => {
  async function customerWithBirthday(name: string, phone: string) {
    const c = await createCustomer(db, name, phone);
    const hoy = await todayLocal();
    await setBirthdayFrom(c.customer_id, hoy);
    return { ...c, hoy };
  }

  const insertGreeting = (
    customerId: string,
    year: number,
    date: string,
    opts: { onConflict?: boolean } = {},
  ) =>
    opts.onConflict
      ? sql`insert into birthday_greetings(customer_id, year, birthday_date, tier_key, message, generated_by)
            values (${customerId}, ${year}, ${date}::date, 'new', 'Saludo', ${staff})
            on conflict (customer_id, year) do nothing`.execute(db)
      : sql`insert into birthday_greetings(customer_id, year, birthday_date, tier_key, message, generated_by)
            values (${customerId}, ${year}, ${date}::date, 'new', 'Saludo', ${staff})`.execute(db);

  it("solo admite un saludo por cliente y año", async () => {
    const c = await customerWithBirthday("Único", "6640000301");
    await insertGreeting(c.customer_id, 2026, "2026-07-15");
    await expect(insertGreeting(c.customer_id, 2026, "2026-07-15")).rejects.toMatchObject({
      code: "23505",
    });
    // Con on conflict do nothing, "generar" dos veces deja una sola fila (idempotencia real).
    await insertGreeting(c.customer_id, 2026, "2026-07-15", { onConflict: true });
    const n = await sql<{
      n: number;
    }>`select count(*)::int as n from birthday_greetings where customer_id = ${c.customer_id}`.execute(
      db,
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it("permite un saludo por año distinto para el mismo cliente", async () => {
    const c = await customerWithBirthday("Anual", "6640000302");
    await insertGreeting(c.customer_id, 2026, "2026-07-15");
    await insertGreeting(c.customer_id, 2027, "2027-07-15");
    const r = await sql<{
      year: number;
    }>`select year from birthday_greetings where customer_id = ${c.customer_id} order by year`.execute(
      db,
    );
    expect(r.rows.map((x) => x.year)).toEqual([2026, 2027]);
  });

  it("exige canal cuando se marca como enviado (y lo prohíbe si no lo está)", async () => {
    const c = await customerWithBirthday("Canal", "6640000303");
    await insertGreeting(c.customer_id, 2026, "2026-07-15");
    await expect(
      sql`update birthday_greetings set sent_at = now() where customer_id = ${c.customer_id} and year = 2026`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await sql`update birthday_greetings set sent_at = now(), channel = 'whatsapp', sent_by = ${staff}
              where customer_id = ${c.customer_id} and year = 2026`.execute(db);
    const r = await sql<{
      channel: string;
      sent_at: Date;
    }>`select channel, sent_at from birthday_greetings where customer_id = ${c.customer_id}`.execute(
      db,
    );
    expect(r.rows[0]!.channel).toBe("whatsapp");
    expect(r.rows[0]!.sent_at).not.toBeNull();
  });

  it("rechaza canales fuera del catálogo", async () => {
    const c = await customerWithBirthday("Canal Malo", "6640000304");
    await expect(
      sql`insert into birthday_greetings(customer_id, year, birthday_date, message, sent_at, channel)
          values (${c.customer_id}, 2026, '2026-07-15', 'x', now(), 'sms')`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("se borra junto con el cliente (on delete cascade)", async () => {
    const c = await customerWithBirthday("Borrable", "6640000305");
    await insertGreeting(c.customer_id, 2026, "2026-07-15");
    await sql`delete from customers where id = ${c.customer_id}`.execute(db);
    const n = await sql<{ n: number }>`select count(*)::int as n from birthday_greetings`.execute(
      db,
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it("conserva el saludo aunque desaparezca el nivel o el usuario que lo envió", async () => {
    const c = await customerWithBirthday("Histórico", "6640000306");
    await sql`insert into birthday_greetings(customer_id, year, birthday_date, tier_key, message, generated_by, sent_at, sent_by, channel)
              values (${c.customer_id}, 2026, '2026-07-15', 'vip', 'Saludo VIP', ${staff}, now(), ${staff}, 'whatsapp')`.execute(
      db,
    );
    await sql`delete from staff_users where id = ${staff}`.execute(db);
    const r = await sql<{ message: string; sent_by: string | null; tier_key: string }>`
      select message, sent_by, tier_key from birthday_greetings where customer_id = ${c.customer_id}`.execute(
      db,
    );
    expect(r.rows[0]!.message).toBe("Saludo VIP");
    expect(r.rows[0]!.sent_by).toBeNull();
    expect(r.rows[0]!.tier_key).toBe("vip");
  });
});
