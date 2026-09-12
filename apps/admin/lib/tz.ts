/**
 * Conversión de fecha/hora "de pared" (input datetime-local, sin zona) a instante UTC según la zona del negocio.
 * Evita que una promo capturada como "12/09 18:00" en Tijuana se guarde como 18:00 UTC en producción.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) {
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${local}`);
    return d; // ya trae zona (ISO completo)
  }
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0);
  // Offset de la zona en ese instante aproximado (dos pasadas para cubrir cambios de horario).
  const offset1 = tzOffsetMs(asUtc, timeZone);
  const guess = asUtc - offset1;
  const offset2 = tzOffsetMs(guess, timeZone);
  return new Date(asUtc - offset2);
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - utcMs;
}

/** Formatea un instante como valor para <input type="datetime-local"> en la zona indicada. */
export function utcToZonedInput(d: Date, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
