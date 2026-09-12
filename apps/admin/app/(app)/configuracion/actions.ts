"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, sql, withStaff } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { bool, failure, num, str, strOrNull, zDate, zId, zTime, zodMessage } from "@/lib/forms";
import { removeStoredImage, uploadFromForm } from "@/lib/uploads";
import type { ActionState } from "@/lib/action-state";

function revalidate() {
  revalidatePath("/configuracion");
  revalidatePath("/dashboard");
}

// ── Negocio ──────────────────────────────────────────────────────────────────
const businessSchema = z.object({
  name: z.string().trim().min(2, "Nombre muy corto").max(80),
  legal_name: z.string().trim().max(160).nullable(),
  tagline: z.string().trim().max(120).nullable(),
  address: z.string().trim().max(300).nullable(),
  city: z.string().trim().max(80).nullable(),
  state: z.string().trim().max(80).nullable(),
  country: z.string().trim().length(2, "País en 2 letras (MX)").toUpperCase(),
  phone: z.string().trim().max(30).nullable(),
  whatsapp: z.string().trim().max(30).nullable(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Email inválido")
    .max(254)
    .nullable()
    .or(z.literal("").transform(() => null)),
  instagram_handle: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((v) => (v ? v.replace(/^@/, "") : v)),
  timezone: z.string().trim().min(3).max(60),
  tax_rate_bps: z.number().int().min(0).max(10000),
  prices_include_tax: z.boolean(),
  allow_negative_stock: z.boolean(),
  low_stock_threshold: z.number().min(0).max(1_000_000),
  order_lead_hours: z.number().int().min(0).max(720),
  policies: z.record(z.string(), z.string().max(4000)),
});

export async function saveBusiness(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("settings.write");
  const tz = str(form, "timezone") ?? "";
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: tz });
  } catch {
    return { error: "Zona horaria inválida" };
  }
  const parsed = businessSchema.safeParse({
    name: str(form, "name") ?? "",
    legal_name: strOrNull(form, "legal_name"),
    tagline: strOrNull(form, "tagline"),
    address: strOrNull(form, "address"),
    city: strOrNull(form, "city"),
    state: strOrNull(form, "state"),
    country: str(form, "country") ?? "MX",
    phone: strOrNull(form, "phone"),
    whatsapp: strOrNull(form, "whatsapp"),
    email: str(form, "email") ?? "",
    instagram_handle: strOrNull(form, "instagram_handle"),
    timezone: tz,
    tax_rate_bps: Math.round((num(form, "tax_rate_pct") ?? 0) * 100),
    prices_include_tax: bool(form, "prices_include_tax"),
    allow_negative_stock: bool(form, "allow_negative_stock"),
    low_stock_threshold: num(form, "low_stock_threshold") ?? 5,
    order_lead_hours: num(form, "order_lead_hours") ?? 24,
    policies: {
      orders: str(form, "policy_orders") ?? "",
      cancellations: str(form, "policy_cancellations") ?? "",
      delivery: str(form, "policy_delivery") ?? "",
      allergens: str(form, "policy_allergens") ?? "",
    },
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    const current = await db()
      .selectFrom("business_settings")
      .select("logo_url")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    const newLogo = await uploadFromForm(form, "logo", "brand");
    const removeLogo = bool(form, "remove_logo");
    const logo_url = newLogo ?? (removeLogo ? null : current.logo_url);
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .updateTable("business_settings")
        .set({ ...parsed.data, policies: JSON.stringify(parsed.data.policies), logo_url })
        .where("id", "=", 1)
        .execute(),
    );
    if ((newLogo || removeLogo) && current.logo_url) await removeStoredImage(current.logo_url);
  } catch (e) {
    return failure("configuracion.negocio", e);
  }
  revalidate();
  return { ok: "Datos del negocio guardados." };
}

// ── Horarios ─────────────────────────────────────────────────────────────────
const hourSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    is_open: z.boolean(),
    opens_at: zTime,
    closes_at: zTime,
  })
  .refine((h) => !h.is_open || (h.opens_at && h.closes_at), {
    message: "Un día abierto necesita hora de apertura y cierre",
  })
  .refine((h) => !h.is_open || h.opens_at! < h.closes_at!, {
    message: "La hora de cierre debe ser posterior a la apertura",
  });

export async function saveHours(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("settings.write");
  const rows: z.infer<typeof hourSchema>[] = [];
  for (let d = 0; d <= 6; d++) {
    const p = hourSchema.safeParse({
      weekday: d,
      is_open: bool(form, `open_${d}`),
      opens_at: strOrNull(form, `opens_${d}`),
      closes_at: strOrNull(form, `closes_${d}`),
    });
    if (!p.success) return { error: `${DAY[d]}: ${zodMessage(p.error)}` };
    rows.push(p.data);
  }
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      for (const r of rows) {
        await trx
          .insertInto("business_hours")
          .values({
            weekday: r.weekday,
            is_open: r.is_open,
            opens_at: r.is_open ? r.opens_at : null,
            closes_at: r.is_open ? r.closes_at : null,
          })
          .onConflict((oc) =>
            oc.column("weekday").doUpdateSet({
              is_open: r.is_open,
              opens_at: r.is_open ? r.opens_at : null,
              closes_at: r.is_open ? r.closes_at : null,
            }),
          )
          .execute();
      }
      await sql`select emit_event('BUSINESS_HOURS_UPDATED', 'business', '1', ${JSON.stringify(rows)}::jsonb)`.execute(
        trx,
      );
    });
  } catch (e) {
    return failure("configuracion.horarios", e);
  }
  revalidate();
  return { ok: "Horarios guardados." };
}

const DAY = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ── Ventanas de pedido ───────────────────────────────────────────────────────
const windowSchema = z
  .object({
    name: z.string().trim().min(2, "Nombre muy corto").max(80),
    fulfillment_type: z.enum(["pickup", "scheduled_pickup", "delivery", "preorder"], {
      error: "Tipo de entrega inválido",
    }),
    order_weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Elige al menos un día para recibir pedidos"),
    cutoff_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Hora límite inválida"),
    fulfillment_weekday: z.number().int().min(0).max(6),
    fulfillment_from: zTime,
    fulfillment_to: zTime,
    lead_days_min: z.number().int().min(0).max(60),
    max_orders: z.number().int().positive().max(100_000).nullable(),
    is_active: z.boolean(),
    sort_order: z.number().int().min(0).max(9999),
  })
  .refine(
    (w) => !(w.fulfillment_from && w.fulfillment_to) || w.fulfillment_from < w.fulfillment_to,
    {
      message: "La hora de fin de entrega debe ser posterior al inicio",
      path: ["fulfillment_to"],
    },
  );

function parseWindow(form: FormData) {
  return windowSchema.safeParse({
    name: str(form, "name") ?? "",
    fulfillment_type: str(form, "fulfillment_type"),
    order_weekdays: form.getAll("order_weekdays").map((v) => Number(v)),
    cutoff_time: str(form, "cutoff_time") ?? "18:00",
    fulfillment_weekday: num(form, "fulfillment_weekday") ?? 5,
    fulfillment_from: strOrNull(form, "fulfillment_from"),
    fulfillment_to: strOrNull(form, "fulfillment_to"),
    lead_days_min: num(form, "lead_days_min") ?? 1,
    max_orders: num(form, "max_orders") ?? null,
    is_active: bool(form, "is_active"),
    sort_order: num(form, "sort_order") ?? 0,
  });
}

export async function saveWindow(
  id: string | null,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("settings.write");
  if (id && !zId.safeParse(id).success) return { error: "Ventana inválida" };
  const parsed = parseWindow(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      if (id)
        await trx.updateTable("ordering_windows").set(parsed.data).where("id", "=", id).execute();
      else await trx.insertInto("ordering_windows").values(parsed.data).execute();
    });
  } catch (e) {
    return failure("configuracion.ventana", e);
  }
  revalidate();
  return { ok: id ? "Ventana guardada." : `Ventana "${parsed.data.name}" creada.` };
}

export async function deleteWindow(id: string): Promise<void> {
  const s = await requireSession("settings.write");
  if (!zId.safeParse(id).success) return;
  const used = await db()
    .selectFrom("orders")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("ordering_window_id", "=", id)
    .executeTakeFirst();
  await withStaff(db(), s.staff.id, async (trx) => {
    if ((used?.n ?? 0) > 0)
      await trx
        .updateTable("ordering_windows")
        .set({ is_active: false })
        .where("id", "=", id)
        .execute();
    else await trx.deleteFrom("ordering_windows").where("id", "=", id).execute();
  });
  revalidate();
}

// ── Calendario ───────────────────────────────────────────────────────────────
const exceptionSchema = z
  .object({
    date: zDate,
    is_closed: z.boolean(),
    no_orders: z.boolean(),
    opens_at: zTime,
    closes_at: zTime,
    note: z.string().trim().max(200).nullable(),
  })
  .refine((e) => e.is_closed || (e.opens_at && e.closes_at && e.opens_at < e.closes_at), {
    message: "Si el día está abierto, indica horario válido (apertura < cierre)",
    path: ["closes_at"],
  });

export async function saveException(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("settings.write");
  const parsed = exceptionSchema.safeParse({
    date: str(form, "date") ?? "",
    is_closed: bool(form, "is_closed"),
    no_orders: bool(form, "no_orders"),
    opens_at: strOrNull(form, "opens_at"),
    closes_at: strOrNull(form, "closes_at"),
    note: strOrNull(form, "note"),
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const v = {
    ...parsed.data,
    opens_at: parsed.data.is_closed ? null : parsed.data.opens_at,
    closes_at: parsed.data.is_closed ? null : parsed.data.closes_at,
  };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("calendar_exceptions")
        .values(v)
        .onConflict((oc) =>
          oc.column("date").doUpdateSet({
            is_closed: v.is_closed,
            no_orders: v.no_orders,
            opens_at: v.opens_at,
            closes_at: v.closes_at,
            note: v.note,
          }),
        )
        .execute(),
    );
  } catch (e) {
    return failure("configuracion.calendario", e);
  }
  revalidate();
  return { ok: "Excepción guardada." };
}

export async function deleteException(id: string): Promise<void> {
  const s = await requireSession("settings.write");
  if (!zId.safeParse(id).success) return;
  await withStaff(db(), s.staff.id, (trx) =>
    trx.deleteFrom("calendar_exceptions").where("id", "=", id).execute(),
  );
  revalidate();
}

// ── Puntos de retiro ─────────────────────────────────────────────────────────
const pickupSchema = z.object({
  name: z.string().trim().min(2, "Nombre muy corto").max(80),
  address: z.string().trim().max(300).nullable(),
  city: z.string().trim().max(80).nullable(),
  notes: z.string().trim().max(300).nullable(),
  map_url: z
    .string()
    .trim()
    .url("URL de mapa inválida")
    .max(500)
    .nullable()
    .or(z.literal("").transform(() => null)),
  is_default: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(9999),
});

function parsePickup(form: FormData) {
  return pickupSchema.safeParse({
    name: str(form, "name") ?? "",
    address: strOrNull(form, "address"),
    city: strOrNull(form, "city"),
    notes: strOrNull(form, "notes"),
    map_url: str(form, "map_url") ?? "",
    is_default: bool(form, "is_default"),
    is_active: bool(form, "is_active"),
    sort_order: num(form, "sort_order") ?? 0,
  });
}

export async function savePickup(
  id: string | null,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("settings.write");
  if (id && !zId.safeParse(id).success) return { error: "Punto inválido" };
  const parsed = parsePickup(form);
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      if (parsed.data.is_default)
        await trx.updateTable("pickup_points").set({ is_default: false }).execute();
      if (id)
        await trx.updateTable("pickup_points").set(parsed.data).where("id", "=", id).execute();
      else await trx.insertInto("pickup_points").values(parsed.data).execute();
      await sql`select emit_event('PICKUP_POINTS_UPDATED', 'business', '1', ${JSON.stringify({ id, name: parsed.data.name })}::jsonb)`.execute(
        trx,
      );
    });
  } catch (e) {
    return failure("configuracion.retiro", e);
  }
  revalidate();
  return { ok: id ? "Punto de retiro guardado." : `Punto "${parsed.data.name}" creado.` };
}

export async function deletePickup(id: string): Promise<void> {
  const s = await requireSession("settings.write");
  if (!zId.safeParse(id).success) return;
  const used = await db()
    .selectFrom("orders")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("pickup_point_id", "=", id)
    .executeTakeFirst();
  await withStaff(db(), s.staff.id, async (trx) => {
    if ((used?.n ?? 0) > 0)
      await trx
        .updateTable("pickup_points")
        .set({ is_active: false, is_default: false })
        .where("id", "=", id)
        .execute();
    else await trx.deleteFrom("pickup_points").where("id", "=", id).execute();
  });
  revalidate();
}

// ── Funciones (feature flags) ────────────────────────────────────────────────
export async function toggleFlag(key: string, enabled: boolean): Promise<void> {
  const s = await requireSession("settings.write");
  if (!/^[a-z0-9_]{2,60}$/.test(key)) return;
  await withStaff(db(), s.staff.id, (trx) =>
    trx.updateTable("feature_flags").set({ enabled }).where("key", "=", key).execute(),
  );
  revalidate();
}
