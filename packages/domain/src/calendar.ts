/**
 * Calendario comercial: ventanas de pedido, cutoff, fechas de entrega, excepciones.
 * Todo se calcula en la zona horaria del negocio usando fechas "civiles" (YYYY-MM-DD) para evitar errores de DST.
 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = domingo

export type OrderingWindow = {
  id: string;
  name: string;
  fulfillmentType: "pickup" | "scheduled_pickup" | "delivery" | "preorder";
  orderWeekdays: Weekday[];
  cutoffTime: string; // "HH:MM"
  fulfillmentWeekday: Weekday;
  fulfillmentFrom?: string | null;
  fulfillmentTo?: string | null;
  leadDaysMin: number;
  isActive: boolean;
};

export type CalendarException = {
  date: string;
  isClosed: boolean;
  noOrders: boolean;
  note?: string | null;
};
export type BusinessHour = {
  weekday: Weekday;
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
};

export type LocalNow = { date: string; time: string; weekday: Weekday };

/** Fecha/hora local del negocio a partir de un instante y una zona IANA. */
export function localNow(at: Date, timeZone: string): LocalNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")] as Weekday;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: wd,
  };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

export function isBlockedDate(
  date: string,
  exceptions: CalendarException[],
): CalendarException | null {
  return exceptions.find((e) => e.date === date && (e.isClosed || e.noOrders)) ?? null;
}

export type FulfillmentOption = {
  windowId: string;
  windowName: string;
  fulfillmentType: OrderingWindow["fulfillmentType"];
  date: string; // fecha de entrega/retiro
  from?: string | null;
  to?: string | null;
  orderBy: { date: string; time: string }; // último momento para pedir
};

/**
 * Próximas fechas válidas de entrega para cada ventana activa, a partir de "ahora".
 * Regla: se puede pedir si hoy está en orderWeekdays y (no es el último día de la ventana o aún no pasa el cutoff),
 * la entrega es el siguiente fulfillmentWeekday con al menos leadDaysMin días de distancia, y la fecha no está bloqueada.
 */
export function nextFulfillmentOptions(
  windows: OrderingWindow[],
  exceptions: CalendarException[],
  now: LocalNow,
  horizonDays = 28,
): FulfillmentOption[] {
  const out: FulfillmentOption[] = [];
  for (const w of windows.filter((x) => x.isActive)) {
    // Buscar la próxima fecha de entrega candidata
    for (let i = 1; i <= horizonDays; i++) {
      const date = addDays(now.date, i);
      if (weekdayOf(date) !== w.fulfillmentWeekday) continue;
      if (isBlockedDate(date, exceptions)) continue;
      const orderBy = lastOrderMoment(w, date, exceptions);
      if (!orderBy) continue;
      const stillOpen =
        orderBy.date > now.date || (orderBy.date === now.date && now.time <= orderBy.time);
      const leadOk = daysBetween(now.date, date) >= w.leadDaysMin;
      if (stillOpen && leadOk) {
        out.push({
          windowId: w.id,
          windowName: w.name,
          fulfillmentType: w.fulfillmentType,
          date,
          from: w.fulfillmentFrom,
          to: w.fulfillmentTo,
          orderBy,
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Último momento para pedir para una entrega en `deliveryDate`: el último orderWeekday anterior a la entrega (respetando cutoff). */
export function lastOrderMoment(
  w: OrderingWindow,
  deliveryDate: string,
  exceptions: CalendarException[],
): { date: string; time: string } | null {
  for (let back = 1; back <= 14; back++) {
    const d = addDays(deliveryDate, -back);
    if (w.orderWeekdays.includes(weekdayOf(d)) && !isBlockedDate(d, exceptions)) {
      return { date: d, time: w.cutoffTime };
    }
  }
  return null;
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** ¿Está abierto el negocio en este momento local? */
export function isOpenNow(
  hours: BusinessHour[],
  exceptions: CalendarException[],
  now: LocalNow,
): { open: boolean; reason?: string; opensAt?: string; closesAt?: string } {
  const ex = exceptions.find((e) => e.date === now.date);
  if (ex?.isClosed) return { open: false, reason: ex.note ?? "Cerrado por hoy" };
  const h = hours.find((x) => x.weekday === now.weekday);
  if (!h || !h.isOpen || !h.opensAt || !h.closesAt) return { open: false, reason: "Cerrado hoy" };
  const open = now.time >= h.opensAt && now.time < h.closesAt;
  return {
    open,
    opensAt: h.opensAt,
    closesAt: h.closesAt,
    reason: open
      ? undefined
      : now.time < h.opensAt
        ? `Abrimos a las ${h.opensAt}`
        : "Ya cerramos por hoy",
  };
}

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

export function formatLocalDate(
  date: string,
  opts: { weekday?: boolean } = { weekday: true },
): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "UTC",
    weekday: opts.weekday ? "long" : undefined,
    day: "numeric",
    month: "long",
  }).format(dt);
}
