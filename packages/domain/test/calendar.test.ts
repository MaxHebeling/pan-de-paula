import { describe, expect, it } from "vitest";
import {
  nextFulfillmentOptions,
  localNow,
  lastOrderMoment,
  isOpenNow,
  addDays,
  weekdayOf,
  type OrderingWindow,
} from "../src/calendar.ts";

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

describe("calendario comercial: lunes–miércoles se pide, viernes se entrega", () => {
  it("martes al mediodía → entrega este viernes, pedir antes del miércoles 18:00", () => {
    const now = { date: "2026-09-15", time: "12:00", weekday: 2 as const }; // martes
    const [opt] = nextFulfillmentOptions([weekly], [], now);
    expect(opt?.date).toBe("2026-09-18");
    expect(opt?.orderBy).toEqual({ date: "2026-09-16", time: "18:00" });
  });
  it("miércoles 18:01 (pasado el cutoff) → siguiente viernes", () => {
    const now = { date: "2026-09-16", time: "18:01", weekday: 3 as const };
    const [opt] = nextFulfillmentOptions([weekly], [], now);
    expect(opt?.date).toBe("2026-09-25");
  });
  it("jueves → siguiente viernes (no el de mañana)", () => {
    const now = { date: "2026-09-17", time: "09:00", weekday: 4 as const };
    const [opt] = nextFulfillmentOptions([weekly], [], now);
    expect(opt?.date).toBe("2026-09-25");
  });
  it("feriado en la fecha de entrega salta a la siguiente", () => {
    const now = { date: "2026-09-15", time: "12:00", weekday: 2 as const };
    const [opt] = nextFulfillmentOptions(
      [weekly],
      [{ date: "2026-09-18", isClosed: true, noOrders: true, note: "Vacaciones" }],
      now,
    );
    expect(opt?.date).toBe("2026-09-25");
  });
  it("ventana inactiva no genera opciones", () => {
    expect(
      nextFulfillmentOptions([{ ...weekly, isActive: false }], [], {
        date: "2026-09-15",
        time: "12:00",
        weekday: 2,
      }),
    ).toEqual([]);
  });
  it("lastOrderMoment respeta días bloqueados", () => {
    expect(
      lastOrderMoment(weekly, "2026-09-18", [
        { date: "2026-09-16", isClosed: true, noOrders: true },
      ]),
    ).toEqual({ date: "2026-09-15", time: "18:00" });
  });
  it("utilidades de fecha", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(weekdayOf("2026-09-18")).toBe(5);
    const ln = localNow(new Date("2026-09-12T02:30:00Z"), "America/Tijuana");
    expect(ln.date).toBe("2026-09-11");
    expect(ln.time).toBe("19:30");
    expect(ln.weekday).toBe(5);
  });
  it("horario de atención", () => {
    const hours = [
      { weekday: 1 as const, isOpen: true, opensAt: "09:00", closesAt: "18:00" },
      { weekday: 0 as const, isOpen: false, opensAt: null, closesAt: null },
    ];
    expect(isOpenNow(hours, [], { date: "2026-09-14", time: "10:00", weekday: 1 }).open).toBe(true);
    expect(isOpenNow(hours, [], { date: "2026-09-14", time: "18:00", weekday: 1 }).open).toBe(
      false,
    );
    expect(isOpenNow(hours, [], { date: "2026-09-13", time: "10:00", weekday: 0 }).open).toBe(
      false,
    );
    expect(
      isOpenNow(hours, [{ date: "2026-09-14", isClosed: true, noOrders: true, note: "Feriado" }], {
        date: "2026-09-14",
        time: "10:00",
        weekday: 1,
      }),
    ).toMatchObject({ open: false, reason: "Feriado" });
  });
});
