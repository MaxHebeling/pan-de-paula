import "server-only";
import { birthdayGreetingMessage } from "@pdp/domain";
import { db, sql } from "./db";

/**
 * Cumpleaños del CRM. La regla de qué día se celebra (incluida la del 29 de febrero) vive en SQL
 * (`observed_birthday` / `celebrates_birthday_on`, migración 0042): aquí no se reimplementa, se llama.
 * Todo se calcula con la fecha LOCAL del negocio (`business_settings.timezone`).
 */

export type GreetingState = "pendiente" | "preparado" | "enviado";

export type BirthdayRow = {
  id: string;
  public_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  birthday: string;
  /** Fecha local en que se celebra (aplica la regla del 29 de febrero). */
  celebrates_on: string;
  /** 0 = hoy, 1 = mañana… */
  days_left: number;
  age: number | null;
  tier_key: string | null;
  tier_name: string | null;
  tier_color: string | null;
  marketing_consent: boolean;
  greeting_generated_at: Date | null;
  greeting_sent_at: Date | null;
  greeting_channel: string | null;
  event_id: number | null;
  event_handled_at: Date | null;
};

export function greetingState(r: {
  greeting_generated_at: Date | null;
  greeting_sent_at: Date | null;
}): GreetingState {
  if (r.greeting_sent_at) return "enviado";
  if (r.greeting_generated_at) return "preparado";
  return "pendiente";
}

export const GREETING_STATE_TONE: Record<GreetingState, "green" | "blue" | "gray"> = {
  enviado: "green",
  preparado: "blue",
  pendiente: "gray",
};

export const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Correo",
  manual: "En persona",
};

/**
 * Cumpleaños desde hoy (día 0) hasta `days` días adelante, en orden cronológico.
 * Se recorre día por día llamando a `celebrates_birthday_on`, de modo que el 29 de febrero
 * aparece en su fecha observada y no se pierde en los años no bisiestos.
 */
export async function birthdaysWindow(days = 30): Promise<BirthdayRow[]> {
  const r = await sql<BirthdayRow>`
    with bs as (select (now() at time zone timezone)::date as today from business_settings where id = 1),
    d as (select bs.today, (bs.today + g)::date as day from bs, generate_series(0, ${days}) g)
    select c.id, c.public_code, c.full_name, c.phone::text as phone, c.email::text as email,
           c.birthday::text as birthday,
           d.day::text as celebrates_on,
           (d.day - d.today)::int as days_left,
           birthday_age_on(c.birthday, d.day) as age,
           c.tier_key, t.name as tier_name, t.color as tier_color, c.marketing_consent,
           g.generated_at as greeting_generated_at, g.sent_at as greeting_sent_at, g.channel as greeting_channel,
           e.id as event_id, e.handled_at as event_handled_at
    from d
    join customers c on celebrates_birthday_on(c.birthday, d.day)
    left join loyalty_tiers t on t.key = c.tier_key
    left join birthday_greetings g on g.customer_id = c.id and g.year = extract(year from d.day)::int
    left join lateral (
      select ce.id, ce.handled_at from customer_events ce
      where ce.customer_id = c.id and ce.kind = 'birthday'
        and (ce.payload->>'date')::date = d.day
      order by ce.id desc limit 1) e on true
    where c.deleted_at is null and c.merged_into_id is null
    order by d.day, c.full_name`.execute(db());
  return r.rows;
}

/** Datos comunes para redactar saludos en lote (nombre del negocio y estado real del programa). */
export async function greetingDefaults(): Promise<{
  businessName: string;
  loyaltyActive: boolean;
  birthdayMultiplier: number;
}> {
  const r = await sql<{ name: string; active: boolean; birthday_multiplier: string }>`
    select bs.name,
           lp.is_active and coalesce(f.enabled, false) as active,
           lp.birthday_multiplier::text as birthday_multiplier
    from business_settings bs, loyalty_program lp
    left join feature_flags f on f.key = 'loyalty'
    where bs.id = 1 and lp.id = 1`.execute(db());
  const x = r.rows[0];
  return {
    businessName: x?.name ?? "El Pan de Paula",
    loyaltyActive: x?.active ?? false,
    birthdayMultiplier: Number(x?.birthday_multiplier ?? 0),
  };
}

export type BirthdayContext = {
  customer: {
    id: string;
    public_code: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    birthday: string;
    tier_key: string | null;
    tier_name: string | null;
    tier_color: string | null;
    marketing_consent: boolean;
  };
  /** Año y fecha local en que se celebra este año (regla del 29 de febrero aplicada). */
  year: number;
  celebrates_on: string;
  days_left: number;
  age: number | null;
  is_today: boolean;
  business: { name: string; tagline: string | null; instagram_handle: string | null };
  loyalty: { active: boolean; birthday_multiplier: number };
  greeting: {
    message: string;
    tier_key: string | null;
    generated_at: Date;
    generated_by_name: string | null;
    sent_at: Date | null;
    sent_by_name: string | null;
    channel: string | null;
  } | null;
  event: { id: number; handled_at: Date | null } | null;
};

/**
 * Todo lo necesario para previsualizar y registrar el saludo de un cliente. Devuelve `null` si el
 * cliente no existe, está eliminado o no tiene fecha de nacimiento (sin fecha no hay saludo).
 */
export async function birthdayContext(customerId: string): Promise<BirthdayContext | null> {
  const r = await sql<{
    id: string;
    public_code: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    birthday: string;
    tier_key: string | null;
    tier_name: string | null;
    tier_color: string | null;
    marketing_consent: boolean;
    year: number;
    celebrates_on: string;
    days_left: number;
    age: number | null;
    biz_name: string;
    tagline: string | null;
    instagram_handle: string | null;
    loyalty_active: boolean;
    birthday_multiplier: string;
    g_message: string | null;
    g_tier_key: string | null;
    g_generated_at: Date | null;
    g_generated_by: string | null;
    g_sent_at: Date | null;
    g_sent_by: string | null;
    g_channel: string | null;
    event_id: number | null;
    event_handled_at: Date | null;
  }>`
    with bs as (select (now() at time zone timezone)::date as today, name, tagline, instagram_handle
                from business_settings where id = 1),
    lp as (select lp.is_active and coalesce(f.enabled, false) as active, lp.birthday_multiplier
           from loyalty_program lp left join feature_flags f on f.key = 'loyalty' where lp.id = 1)
    select c.id, c.public_code, c.full_name, c.phone::text as phone, c.email::text as email,
           c.birthday::text as birthday, c.tier_key, t.name as tier_name, t.color as tier_color,
           c.marketing_consent,
           extract(year from bs.today)::int as year,
           observed_birthday(c.birthday, extract(year from bs.today)::int)::text as celebrates_on,
           (observed_birthday(c.birthday, extract(year from bs.today)::int) - bs.today)::int as days_left,
           birthday_age_on(c.birthday, observed_birthday(c.birthday, extract(year from bs.today)::int)) as age,
           bs.name as biz_name, bs.tagline, bs.instagram_handle,
           lp.active as loyalty_active, lp.birthday_multiplier::text as birthday_multiplier,
           g.message as g_message, g.tier_key as g_tier_key, g.generated_at as g_generated_at,
           gs.full_name as g_generated_by, g.sent_at as g_sent_at, ss.full_name as g_sent_by, g.channel as g_channel,
           e.id as event_id, e.handled_at as event_handled_at
    from customers c
    cross join bs cross join lp
    left join loyalty_tiers t on t.key = c.tier_key
    left join birthday_greetings g on g.customer_id = c.id and g.year = extract(year from bs.today)::int
    left join staff_users gs on gs.id = g.generated_by
    left join staff_users ss on ss.id = g.sent_by
    left join lateral (
      select ce.id, ce.handled_at from customer_events ce
      where ce.customer_id = c.id and ce.kind = 'birthday'
        and (ce.payload->>'date')::date = bs.today
      order by ce.id desc limit 1) e on true
    where c.id = ${customerId} and c.deleted_at is null and c.birthday is not null`.execute(db());
  const x = r.rows[0];
  if (!x) return null;
  return {
    customer: {
      id: x.id,
      public_code: x.public_code,
      full_name: x.full_name,
      phone: x.phone,
      email: x.email,
      birthday: x.birthday,
      tier_key: x.tier_key,
      tier_name: x.tier_name,
      tier_color: x.tier_color,
      marketing_consent: x.marketing_consent,
    },
    year: x.year,
    celebrates_on: x.celebrates_on,
    days_left: x.days_left,
    age: x.age,
    is_today: x.days_left === 0,
    business: { name: x.biz_name, tagline: x.tagline, instagram_handle: x.instagram_handle },
    loyalty: { active: x.loyalty_active, birthday_multiplier: Number(x.birthday_multiplier) },
    greeting: x.g_generated_at
      ? {
          message: x.g_message ?? "",
          tier_key: x.g_tier_key,
          generated_at: x.g_generated_at,
          generated_by_name: x.g_generated_by,
          sent_at: x.g_sent_at,
          sent_by_name: x.g_sent_by,
          channel: x.g_channel,
        }
      : null,
    event: x.event_id ? { id: x.event_id, handled_at: x.event_handled_at } : null,
  };
}

/** Texto del saludo para un contexto: el guardado si ya existe, o el que propone `@pdp/domain`. */
export function greetingTextFor(ctx: BirthdayContext): string {
  if (ctx.greeting?.message) return ctx.greeting.message;
  return birthdayGreetingMessage({
    fullName: ctx.customer.full_name,
    tierKey: ctx.customer.tier_key,
    businessName: ctx.business.name,
    loyaltyActive: ctx.loyalty.active,
    birthdayMultiplier: ctx.loyalty.birthday_multiplier,
  });
}

/** Fecha de cumpleaños legible ("4 de mayo"), sin año y sin desfases de zona horaria. */
export function formatBirthday(date: string, withYear = false): string {
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(date + "T00:00:00Z"));
}
