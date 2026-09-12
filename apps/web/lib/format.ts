/** Formateadores seguros para cliente y servidor. */
import { formatMXN } from "@pdp/domain";

export const money = (cents: number, compact = false) => formatMXN(cents, { compact });

/** "09:00" → "9:00 a. m." (es-MX). */
export function hour12(hm: string | null | undefined): string {
  if (!hm) return "";
  const [h, m] = hm.slice(0, 5).split(":").map(Number) as [number, number];
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat("es-MX", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(d);
}

export function hourRange(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to) return `${hour12(from)} – ${hour12(to)}`;
  if (from) return `desde ${hour12(from)}`;
  if (to) return `hasta ${hour12(to)}`;
  return "";
}

export function dateTimeMX(d: Date | string, timeZone: string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

export function dateMX(d: Date | string, timeZone: string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(dt);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Etiqueta amable de modalidad de entrega. */
export const FULFILLMENT_LABELS: Record<string, string> = {
  pickup: "Recoger en tienda",
  scheduled_pickup: "Recoger en fecha programada",
  delivery: "Entrega a domicilio",
  preorder: "Pedido anticipado",
};
