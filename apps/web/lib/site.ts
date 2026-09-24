import "server-only";
import { cache } from "react";
import { db, sql } from "@/lib/db";
import {
  isOpenNow,
  localNow,
  nextFulfillmentOptions,
  type BusinessHour,
  type CalendarException,
  type FulfillmentOption,
  type LocalNow,
  type OrderingWindow,
  phoneToE164Digits,
  type Weekday,
} from "@pdp/domain";

/** Claves opcionales dentro de business_settings.policies que el sitio sabe mostrar. */
export type Policies = {
  about?: string;
  transfer_instructions?: string;
  privacy?: string;
  terms?: string;
  delivery_fee_cents?: number;
  delivery_zone?: string;
  map_embed_url?: string;
  /** Enlace de la ficha del negocio en Google Maps (el que se comparte desde la app). */
  maps_url?: string;
};

export type PickupPoint = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  notes: string | null;
  mapUrl: string | null;
  isDefault: boolean;
};

export type Business = {
  name: string;
  tagline: string | null;
  legalName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  instagramHandle: string | null;
  timezone: string;
  policies: Policies;
  hours: BusinessHour[];
  exceptions: CalendarException[];
  windows: OrderingWindow[];
  pickupPoints: PickupPoint[];
  flags: Record<string, boolean>;
};

/** "09:00:00" (Postgres time) → "09:00" para comparar con LocalNow.time. */
export const hm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null);

function policiesFrom(raw: unknown): Policies {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const str = (k: string) =>
    typeof p[k] === "string" && p[k].trim() ? (p[k] as string) : undefined;
  const fee =
    typeof p.delivery_fee_cents === "number"
      ? Math.max(0, Math.round(p.delivery_fee_cents))
      : undefined;
  return {
    about: str("about"),
    transfer_instructions: str("transfer_instructions"),
    privacy: str("privacy"),
    terms: str("terms"),
    delivery_zone: str("delivery_zone"),
    map_embed_url: str("map_embed_url"),
    maps_url: str("maps_url"),
    delivery_fee_cents: fee,
  };
}

/** Configuración del negocio + calendario + puntos de retiro + flags. Cacheado por request. */
export const getBusiness = cache(async (): Promise<Business> => {
  const d = db();
  const [settings, hours, exceptions, windows, points, flags] = await Promise.all([
    d.selectFrom("business_settings").selectAll().where("id", "=", 1).executeTakeFirstOrThrow(),
    d.selectFrom("business_hours").selectAll().orderBy("weekday").execute(),
    sql<{ date: string; is_closed: boolean; no_orders: boolean; note: string | null }>`
      select to_char(date, 'YYYY-MM-DD') as date, is_closed, no_orders, note
      from calendar_exceptions
      where date >= current_date - 1 and date <= current_date + 60`.execute(d),
    d
      .selectFrom("ordering_windows")
      .selectAll()
      .where("is_active", "=", true)
      .orderBy("sort_order")
      .orderBy("name")
      .execute(),
    d
      .selectFrom("pickup_points")
      .selectAll()
      .where("is_active", "=", true)
      .orderBy("is_default", "desc")
      .orderBy("sort_order")
      .execute(),
    d.selectFrom("feature_flags").select(["key", "enabled"]).execute(),
  ]);
  return {
    name: settings.name,
    tagline: settings.tagline,
    legalName: settings.legal_name,
    address: settings.address,
    city: settings.city,
    state: settings.state,
    phone: settings.phone,
    whatsapp: settings.whatsapp,
    email: settings.email,
    instagramHandle: settings.instagram_handle?.replace(/^@/, "") ?? null,
    timezone: settings.timezone,
    policies: policiesFrom(settings.policies),
    hours: hours.map((h) => ({
      weekday: h.weekday as Weekday,
      isOpen: h.is_open,
      opensAt: hm(h.opens_at),
      closesAt: hm(h.closes_at),
    })),
    exceptions: exceptions.rows.map((e) => ({
      date: e.date,
      isClosed: e.is_closed,
      noOrders: e.no_orders,
      note: e.note,
    })),
    windows: windows.map((w) => ({
      id: w.id,
      name: w.name,
      fulfillmentType: w.fulfillment_type,
      orderWeekdays: w.order_weekdays as Weekday[],
      cutoffTime: hm(w.cutoff_time) ?? "18:00",
      fulfillmentWeekday: w.fulfillment_weekday as Weekday,
      fulfillmentFrom: hm(w.fulfillment_from),
      fulfillmentTo: hm(w.fulfillment_to),
      leadDaysMin: w.lead_days_min,
      isActive: w.is_active,
    })),
    pickupPoints: points.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      city: p.city,
      notes: p.notes,
      mapUrl: p.map_url,
      isDefault: p.is_default,
    })),
    flags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])),
  };
});

export function nowFor(b: Business): LocalNow {
  return localNow(new Date(), b.timezone);
}

export function openStatus(b: Business) {
  return isOpenNow(b.hours, b.exceptions, nowFor(b));
}

export function fulfillmentOptions(b: Business): FulfillmentOption[] {
  return nextFulfillmentOptions(b.windows, b.exceptions, nowFor(b));
}

/** Dirección legible en una línea (o null si el negocio aún no la configura). */
export function fullAddress(b: Business): string | null {
  const parts = [b.address, b.city, b.state].filter((x): x is string => Boolean(x && x.trim()));
  return parts.length ? parts.join(", ") : null;
}

/**
 * Mapa del negocio. Sin clave de API: el buscador de Google acepta la dirección tal cual y la
 * resuelve —comprobado contra la dirección real del negocio—. `policies.map_embed_url` permite fijar
 * un lugar concreto el día que el geocodificador falle o se quiera apuntar a la ficha del local.
 */
export function mapEmbedUrl(b: Business): string | null {
  const fijo = b.policies.map_embed_url?.trim();
  if (fijo) return fijo;
  const dir = fullAddress(b);
  // `z=16` acerca a la manzana: con el encuadre ancho de la portada, el zoom por omisión dejaba
  // medio mapa en mar abierto.
  return dir ? `https://www.google.com/maps?q=${encodeURIComponent(dir)}&z=16&output=embed` : null;
}

/**
 * Enlace para abrir la ubicación en la app de Google Maps, o en su sitio si no está instalada.
 * Si hay ficha del negocio (`policies.maps_url`) se usa esa: abre el local con su nombre, sus fotos
 * y sus reseñas, no una búsqueda por texto que puede caer en el portal de enfrente.
 */
export function mapsLinkUrl(b: Business): string | null {
  const ficha = b.policies.maps_url?.trim();
  if (ficha) return ficha;
  const dir = fullAddress(b);
  return dir ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dir)}` : null;
}

/**
 * Teléfono/WhatsApp a dígitos para enlaces wa.me / tel:. Misma regla que el CRM
 * (`phoneToE164Digits` de `@pdp/domain`): México se marca con 52 + 10 dígitos y un número guardado
 * en E.164 ya trae su prefijo.
 */
export function digits(s: string | null | undefined): string | null {
  return phoneToE164Digits(s);
}

/**
 * Enlace al perfil de Instagram a partir del handle centralizado (`business_settings.instagram_handle`,
 * editable en el CRM → Configuración). Único lugar donde se arma la URL: nunca se escribe el handle a mano.
 */
export function instagramUrl(handle: string | null | undefined): string | null {
  const h = handle?.trim().replace(/^@/, "");
  return h ? `https://www.instagram.com/${h}/` : null;
}

export function whatsappLink(b: Business, text?: string): string | null {
  const d = digits(b.whatsapp ?? b.phone);
  if (!d) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
