/**
 * Auditoría del calendario comercial con relojes fijos: límites exactos de apertura/cierre, medianoche,
 * cambio de día America/Tijuana vs UTC, excepciones, días sin horario, horario nocturno, cutoff al minuto,
 * lead days y ventanas inactivas.
 */
import { describe, expect, it } from "vitest";
import {
  isOpenNow,
  lastOrderMoment,
  localNow,
  nextFulfillmentOptions,
  weekdayOf,
  type BusinessHour,
  type OrderingWindow,
} from "../src/calendar.ts";

const TZ = "America/Tijuana";
const hours: BusinessHour[] = [
  { weekday: 0, isOpen: false, opensAt: null, closesAt: null },
  { weekday: 1, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 2, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 3, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 4, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 5, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 6, isOpen: true, opensAt: "09:00", closesAt: "14:00" },
];
const at = (date: string, time: string) => ({ date, time, weekday: weekdayOf(date) });

describe("isOpenNow · límites exactos", () => {
  it("abre en el minuto de apertura (inclusive) y cierra en el minuto de cierre (exclusivo)", () => {
    expect(isOpenNow(hours, [], at("2026-09-14", "08:59")).open).toBe(false);
    expect(isOpenNow(hours, [], at("2026-09-14", "09:00")).open).toBe(true);
    expect(isOpenNow(hours, [], at("2026-09-14", "17:59")).open).toBe(true);
    expect(isOpenNow(hours, [], at("2026-09-14", "18:00"))).toMatchObject({
      open: false,
      reason: "Ya cerramos por hoy",
    });
    expect(isOpenNow(hours, [], at("2026-09-14", "08:00"))).toMatchObject({
      open: false,
      reason: "Abrimos a las 09:00",
    });
  });
  it("sábado cierra a las 14:00; domingo y días sin registro de horario están cerrados", () => {
    expect(isOpenNow(hours, [], at("2026-09-19", "13:59")).open).toBe(true);
    expect(isOpenNow(hours, [], at("2026-09-19", "14:00")).open).toBe(false);
    expect(isOpenNow(hours, [], at("2026-09-20", "10:00"))).toMatchObject({
      open: false,
      reason: "Cerrado hoy",
    });
    expect(isOpenNow([], [], at("2026-09-14", "10:00"))).toMatchObject({
      open: false,
      reason: "Cerrado hoy",
    });
    expect(
      isOpenNow(
        [{ weekday: 1, isOpen: true, opensAt: null, closesAt: null }],
        [],
        at("2026-09-14", "10:00"),
      ).open,
    ).toBe(false);
  });
  it("medianoche: 23:59 es del día en curso y 00:00 ya es el siguiente", () => {
    expect(isOpenNow(hours, [], at("2026-09-14", "23:59")).open).toBe(false);
    expect(isOpenNow(hours, [], at("2026-09-15", "00:00")).open).toBe(false);
    expect(isOpenNow(hours, [], at("2026-09-15", "00:00")).reason).toBe("Abrimos a las 09:00");
  });
  it("excepción de calendario solo afecta a su fecha", () => {
    const ex = [{ date: "2026-09-14", isClosed: true, noOrders: true, note: "Inventario" }];
    expect(isOpenNow(hours, ex, at("2026-09-14", "10:00"))).toMatchObject({
      open: false,
      reason: "Inventario",
    });
    expect(isOpenNow(hours, ex, at("2026-09-15", "10:00")).open).toBe(true);
    // Excepción "sin pedidos" pero abierto al público: la tienda sigue abierta
    expect(
      isOpenNow(
        hours,
        [{ date: "2026-09-14", isClosed: false, noOrders: true }],
        at("2026-09-14", "10:00"),
      ).open,
    ).toBe(true);
  });
  it("horario nocturno (cierra después de medianoche) y cierre a las 00:00", () => {
    const night: BusinessHour[] = [
      { weekday: 5, isOpen: true, opensAt: "20:00", closesAt: "02:00" },
    ];
    expect(isOpenNow(night, [], at("2026-09-18", "19:59")).open).toBe(false);
    expect(isOpenNow(night, [], at("2026-09-18", "20:00")).open).toBe(true);
    expect(isOpenNow(night, [], at("2026-09-18", "23:59")).open).toBe(true);
    expect(isOpenNow(night, [], at("2026-09-18", "01:59")).open).toBe(true);
    expect(isOpenNow(night, [], at("2026-09-18", "02:00")).open).toBe(false);
    const untilMidnight: BusinessHour[] = [
      { weekday: 5, isOpen: true, opensAt: "09:00", closesAt: "00:00" },
    ];
    expect(isOpenNow(untilMidnight, [], at("2026-09-18", "23:59")).open).toBe(true);
    expect(isOpenNow(untilMidnight, [], at("2026-09-18", "08:59")).open).toBe(false);
  });
});

describe("localNow · America/Tijuana frente a UTC", () => {
  it("el cambio de día ocurre a las 07:00Z (PDT) y no a medianoche UTC", () => {
    expect(localNow(new Date("2026-09-13T06:59:00Z"), TZ)).toEqual({
      date: "2026-09-12",
      time: "23:59",
      weekday: 6,
    });
    expect(localNow(new Date("2026-09-13T07:00:00Z"), TZ)).toEqual({
      date: "2026-09-13",
      time: "00:00",
      weekday: 0,
    });
    expect(localNow(new Date("2026-09-13T00:30:00Z"), TZ)).toEqual({
      date: "2026-09-12",
      time: "17:30",
      weekday: 6,
    });
  });
  it("en horario estándar (PST) el corte es a las 08:00Z; el cambio de horario no rompe la fecha", () => {
    expect(localNow(new Date("2026-12-10T07:59:00Z"), TZ)).toEqual({
      date: "2026-12-09",
      time: "23:59",
      weekday: 3,
    });
    expect(localNow(new Date("2026-12-10T08:00:00Z"), TZ)).toEqual({
      date: "2026-12-10",
      time: "00:00",
      weekday: 4,
    });
    // 2026-03-08 02:00 PST → 03:00 PDT (la hora 02:xx no existe)
    expect(localNow(new Date("2026-03-08T10:00:00Z"), TZ).time).toBe("03:00");
    expect(localNow(new Date("2026-03-08T09:59:00Z"), TZ).time).toBe("01:59");
  });
  it("el weekday de localNow coincide con weekdayOf de la fecha civil", () => {
    for (const iso of [
      "2026-09-13T06:59:00Z",
      "2026-09-13T07:00:00Z",
      "2026-11-01T08:30:00Z",
      "2027-01-01T07:30:00Z",
    ]) {
      const ln = localNow(new Date(iso), TZ);
      expect(ln.weekday).toBe(weekdayOf(ln.date));
    }
  });
});

const weekly: OrderingWindow = {
  id: "w1",
  name: "Pedidos de la semana",
  fulfillmentType: "scheduled_pickup",
  orderWeekdays: [1, 2, 3],
  cutoffTime: "18:00",
  fulfillmentWeekday: 5,
  fulfillmentFrom: "10:00",
  fulfillmentTo: "18:00",
  leadDaysMin: 1,
  isActive: true,
};

describe("nextFulfillmentOptions · cutoff al minuto, lead days, excepciones", () => {
  it("miércoles 17:59 y 18:00 aún alcanzan este viernes; 18:01 pasa al siguiente", () => {
    expect(nextFulfillmentOptions([weekly], [], at("2026-09-16", "17:59"))[0]?.date).toBe(
      "2026-09-18",
    );
    expect(nextFulfillmentOptions([weekly], [], at("2026-09-16", "18:00"))[0]?.date).toBe(
      "2026-09-18",
    );
    expect(nextFulfillmentOptions([weekly], [], at("2026-09-16", "18:01"))[0]?.date).toBe(
      "2026-09-25",
    );
  });
  it("visto desde UTC: miércoles 18:00 Tijuana = jueves 01:00Z; la decisión usa la hora local", () => {
    const ln = localNow(new Date("2026-09-17T01:00:00Z"), TZ);
    expect(ln).toEqual({ date: "2026-09-16", time: "18:00", weekday: 3 });
    expect(nextFulfillmentOptions([weekly], [], ln)[0]?.date).toBe("2026-09-18");
    expect(
      nextFulfillmentOptions([weekly], [], localNow(new Date("2026-09-17T01:01:00Z"), TZ))[0]?.date,
    ).toBe("2026-09-25");
  });
  it("leadDaysMin se respeta aunque el cutoff no haya pasado", () => {
    const lead3 = { ...weekly, leadDaysMin: 3 };
    // martes 15 → viernes 18 son 3 días: válido; miércoles 16 → 2 días: salta al 25
    expect(nextFulfillmentOptions([lead3], [], at("2026-09-15", "12:00"))[0]?.date).toBe(
      "2026-09-18",
    );
    expect(nextFulfillmentOptions([lead3], [], at("2026-09-16", "12:00"))[0]?.date).toBe(
      "2026-09-25",
    );
  });
  it("sin ventanas activas no hay opciones; varias ventanas se ordenan por fecha", () => {
    expect(nextFulfillmentOptions([], [], at("2026-09-15", "12:00"))).toEqual([]);
    expect(
      nextFulfillmentOptions([{ ...weekly, isActive: false }], [], at("2026-09-15", "12:00")),
    ).toEqual([]);
    const sat: OrderingWindow = { ...weekly, id: "w2", fulfillmentWeekday: 6, orderWeekdays: [4] };
    const opts = nextFulfillmentOptions([sat, weekly], [], at("2026-09-15", "12:00"));
    expect(opts.map((o) => o.date)).toEqual(["2026-09-18", "2026-09-19"]);
  });
  it("feriado en el día de pedido adelanta el cutoff; feriado en la entrega la salta", () => {
    const orderDayBlocked = [{ date: "2026-09-16", isClosed: true, noOrders: true }];
    const [opt] = nextFulfillmentOptions([weekly], orderDayBlocked, at("2026-09-15", "12:00"));
    expect(opt?.orderBy).toEqual({ date: "2026-09-15", time: "18:00" });
    // ya es miércoles (bloqueado) → el último momento fue el martes: ya no alcanza
    expect(
      nextFulfillmentOptions([weekly], orderDayBlocked, at("2026-09-16", "12:00"))[0]?.date,
    ).toBe("2026-09-25");
    const deliveryNoOrders = [{ date: "2026-09-18", isClosed: false, noOrders: true }];
    expect(
      nextFulfillmentOptions([weekly], deliveryNoOrders, at("2026-09-15", "12:00"))[0]?.date,
    ).toBe("2026-09-25");
  });
  it("lastOrderMoment devuelve null si no hay día de pedido en dos semanas", () => {
    const never: OrderingWindow = { ...weekly, orderWeekdays: [] };
    expect(lastOrderMoment(never, "2026-09-18", [])).toBeNull();
    expect(nextFulfillmentOptions([never], [], at("2026-09-15", "12:00"))).toEqual([]);
  });
});
