/**
 * Horario real del negocio (packages/db/import/negocio/2026-09-16-horario-viernes.sql):
 * atención y entrega solo viernes 18:00–22:00, pedidos cualquier día con cierre el miércoles 18:00.
 * El archivo se aplica dentro de una transacción que se revierte: la base de pruebas queda como estaba.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nextFulfillmentOptions, type OrderingWindow, type Weekday } from "@pdp/domain";
import { sql, testDb } from "./helpers.ts";
import type { Transaction } from "kysely";
import type { DB } from "../src/generated/db.ts";

const { db, pool } = testDb();
const FILE = resolve(import.meta.dirname, "../import/negocio/2026-09-16-horario-viernes.sql");

/** El archivo es para psql: se quitan las metainstrucciones y el begin/commit propio. */
function statements(): string {
  return readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("\\") && l.trim() !== "begin;" && l.trim() !== "commit;")
    .join("\n");
}

type Hour = {
  weekday: number;
  is_open: boolean;
  opens_at: string | null;
  closes_at: string | null;
};
type Win = {
  id: string;
  name: string;
  order_weekdays: number[];
  cutoff_time: string;
  fulfillment_weekday: number;
  fulfillment_from: string | null;
  fulfillment_to: string | null;
  lead_days_min: number;
  is_active: boolean;
};

/** Aplica el archivo, deja consultar el resultado y revierte siempre. */
async function conHorario<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  let out!: T;
  await db
    .transaction()
    .execute(async (trx) => {
      await sql.raw(statements()).execute(trx);
      out = await fn(trx);
      throw new Error("rollback");
    })
    .catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
  return out;
}

const hours = (trx: Transaction<DB>) =>
  sql<Hour>`select weekday, is_open, opens_at::text as opens_at, closes_at::text as closes_at
              from business_hours order by weekday`
    .execute(trx)
    .then((r) => r.rows);
const windows = (trx: Transaction<DB>) =>
  sql<Win>`select id, name, order_weekdays, cutoff_time::text as cutoff_time, fulfillment_weekday,
                  fulfillment_from::text as fulfillment_from, fulfillment_to::text as fulfillment_to,
                  lead_days_min, is_active
             from ordering_windows where is_active order by sort_order`
    .execute(trx)
    .then((r) => r.rows);

const toDomain = (w: Win): OrderingWindow => ({
  id: w.id,
  name: w.name,
  fulfillmentType: "scheduled_pickup",
  orderWeekdays: w.order_weekdays as Weekday[],
  cutoffTime: w.cutoff_time.slice(0, 5),
  fulfillmentWeekday: w.fulfillment_weekday as Weekday,
  fulfillmentFrom: w.fulfillment_from,
  fulfillmentTo: w.fulfillment_to,
  leadDaysMin: w.lead_days_min,
  isActive: w.is_active,
});

afterAll(async () => {
  await db.destroy();
  await pool.end().catch(() => {});
});

describe("horario del negocio: viernes 18:00–22:00", () => {
  it("deja abierto solo el viernes y cierra el resto de los días", async () => {
    const rows = await conHorario(hours);
    expect(rows.filter((h) => h.is_open).map((h) => h.weekday)).toEqual([5]);
    expect(rows.find((h) => h.weekday === 5)).toMatchObject({
      opens_at: "18:00:00",
      closes_at: "22:00:00",
    });
    for (const h of rows.filter((x) => x.weekday !== 5))
      expect([h.opens_at, h.closes_at]).toEqual([null, null]);
  });

  it("deja una sola ventana de pedidos, con entrega el viernes en el mismo horario", async () => {
    const ws = await conHorario(windows);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      name: "Viernes",
      order_weekdays: [0, 1, 2, 3],
      cutoff_time: "18:00:00",
      fulfillment_weekday: 5,
      fulfillment_from: "18:00:00",
      fulfillment_to: "22:00:00",
      lead_days_min: 1,
    });
  });

  it("el cliente que entra el lunes ve el viernes de esa semana y el cierre el miércoles a las 18:00", async () => {
    const ws = await conHorario(windows);
    const [opt] = nextFulfillmentOptions([toDomain(ws[0]!)], [], {
      date: "2026-09-14", // lunes
      time: "10:00",
      weekday: 1,
    });
    expect(opt).toMatchObject({
      date: "2026-09-18", // viernes
      from: "18:00:00",
      to: "22:00:00",
      orderBy: { date: "2026-09-16", time: "18:00" }, // miércoles
    });
  });

  it("después del cierre (jueves) la tienda ofrece el viernes siguiente, no el de mañana", async () => {
    const ws = await conHorario(windows);
    const [opt] = nextFulfillmentOptions([toDomain(ws[0]!)], [], {
      date: "2026-09-17", // jueves
      time: "09:00",
      weekday: 4,
    });
    expect(opt).toMatchObject({ date: "2026-09-25", orderBy: { date: "2026-09-23" } });
  });

  it("el miércoles antes de las 18:00 todavía alcanza; después ya no", async () => {
    const ws = await conHorario(windows);
    const w = toDomain(ws[0]!);
    const antes = nextFulfillmentOptions([w], [], {
      date: "2026-09-16",
      time: "17:59",
      weekday: 3,
    });
    const despues = nextFulfillmentOptions([w], [], {
      date: "2026-09-16",
      time: "18:01",
      weekday: 3,
    });
    expect(antes[0]?.date).toBe("2026-09-18");
    expect(despues[0]?.date).toBe("2026-09-25");
  });

  it("aplicarlo dos veces deja exactamente el mismo estado (idempotente)", async () => {
    const dos = await conHorario(async (trx) => {
      await sql.raw(statements()).execute(trx);
      return { hours: await hours(trx), windows: await windows(trx) };
    });
    expect(dos.hours.filter((h) => h.is_open).map((h) => h.weekday)).toEqual([5]);
    expect(dos.windows).toHaveLength(1);
  });
});
