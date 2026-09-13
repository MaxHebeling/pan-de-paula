"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { db, sql, callFn, withStaff, dbErrorMessage } from "@/lib/db";
import { bool, cents, num, optStr, str, type ActionState } from "@/lib/action-state";
import { VALIDATE_REASONS } from "@/lib/coupons";
import { zonedToUtc } from "@/lib/tz";

/** Zona del negocio: las fechas del formulario (AAAA-MM-DD) se interpretan como días locales completos. */
async function businessTz(): Promise<string> {
  const r = await sql<{
    timezone: string;
  }>`select timezone from business_settings where id = 1`.execute(db());
  return r.rows[0]?.timezone ?? "America/Tijuana";
}
const dateRx = /^\d{4}-\d{2}-\d{2}$/;

const uuid = z.string().uuid();

const couponSchema = z
  .object({
    id: uuid.optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,40}$/, "Código: 3–40 letras/números/guiones"),
    name: z.string().trim().max(120).optional(),
    kind: z.enum(["pct", "amount", "free_product"]),
    value_bps: z.number().int().min(1).max(10000).optional(),
    value_cents: z.number().int().min(1).optional(),
    product_id: uuid.optional(),
    min_subtotal_cents: z.number().int().min(0),
    starts_at: z.string().regex(dateRx, "Fecha de inicio inválida").optional(),
    ends_at: z.string().regex(dateRx, "Fecha de fin inválida").optional(),
    max_uses: z.number().int().min(1).optional(),
    max_uses_per_customer: z.number().int().min(1).max(1000),
    channels: z.array(z.enum(["all", "web", "pos"])).min(1, "Elige al menos un canal"),
    tiers: z.array(z.string().max(30)),
    new_customers_only: z.boolean(),
    is_active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "pct" && !v.value_bps)
      ctx.addIssue({
        code: "custom",
        message: "Indica el porcentaje (1–100)",
        path: ["value_bps"],
      });
    if (v.kind === "amount" && !v.value_cents)
      ctx.addIssue({
        code: "custom",
        message: "Indica el monto del descuento",
        path: ["value_cents"],
      });
    if (v.kind === "free_product" && !v.product_id)
      ctx.addIssue({
        code: "custom",
        message: "Selecciona el producto gratis",
        path: ["product_id"],
      });
    if (v.starts_at && v.ends_at && v.ends_at < v.starts_at)
      ctx.addIssue({
        code: "custom",
        message: "La vigencia termina antes de empezar",
        path: ["ends_at"],
      });
  });

function parseCoupon(fd: FormData) {
  const pct = num(fd, "value_pct");
  return couponSchema.safeParse({
    id: optStr(fd, "id"),
    code: str(fd, "code"),
    name: optStr(fd, "name"),
    kind: str(fd, "kind"),
    value_bps: pct === undefined ? undefined : Math.round(pct * 100),
    value_cents: cents(fd, "value_pesos"),
    product_id: optStr(fd, "product_id"),
    min_subtotal_cents: cents(fd, "min_subtotal_pesos") ?? 0,
    starts_at: optStr(fd, "starts_at"),
    ends_at: optStr(fd, "ends_at"),
    max_uses: num(fd, "max_uses"),
    max_uses_per_customer: num(fd, "max_uses_per_customer") ?? 1,
    channels: fd.getAll("channels").map(String),
    tiers: fd.getAll("tiers").map(String),
    new_customers_only: bool(fd, "new_customers_only"),
    is_active: bool(fd, "is_active"),
  });
}

export async function upsertCouponAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = parseCoupon(fd);
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const c = p.data;
  const channels = c.channels.includes("all") ? ["all"] : c.channels;
  const segment: Record<string, unknown> = {};
  if (c.tiers.length) segment.tiers = c.tiers;
  if (c.new_customers_only) segment.new_customers_only = true;
  const valueBps = c.kind === "pct" ? c.value_bps! : null;
  const valueCents = c.kind === "amount" ? c.value_cents! : null;
  const productId = c.kind === "free_product" || c.kind === "pct" ? (c.product_id ?? null) : null;
  // Antes se guardaban como texto sin zona: en producción (UTC) el cupón arrancaba 7–8 h antes y
  // vencía a las 16:59 hora local. Ahora: inicio 00:00 y fin 23:59:59 del día en la zona del negocio.
  const tz = await businessTz();
  const startsAt = c.starts_at ? zonedToUtc(`${c.starts_at}T00:00:00`, tz).toISOString() : null;
  const endsAt = c.ends_at ? zonedToUtc(`${c.ends_at}T23:59:59`, tz).toISOString() : null;
  let id = c.id;
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      if (c.id) {
        await sql`update coupons set code = ${c.code}, name = ${c.name ?? null}, kind = ${c.kind}::coupon_kind, value_bps = ${valueBps}, value_cents = ${valueCents},
                  product_id = ${productId}, min_subtotal_cents = ${c.min_subtotal_cents}, starts_at = ${startsAt}, ends_at = ${endsAt},
                  max_uses = ${c.max_uses ?? null}, max_uses_per_customer = ${c.max_uses_per_customer}, channels = ${channels}::price_channel[],
                  segment = ${JSON.stringify(segment)}::jsonb, is_active = ${c.is_active} where id = ${c.id}`.execute(
          trx,
        );
      } else {
        const r = await sql<{
          id: string;
        }>`insert into coupons(code, name, kind, value_bps, value_cents, product_id, min_subtotal_cents, starts_at, ends_at, max_uses, max_uses_per_customer, channels, segment, is_active, created_by)
                  values (${c.code}, ${c.name ?? null}, ${c.kind}::coupon_kind, ${valueBps}, ${valueCents}, ${productId}, ${c.min_subtotal_cents}, ${startsAt}, ${endsAt},
                          ${c.max_uses ?? null}, ${c.max_uses_per_customer}, ${channels}::price_channel[], ${JSON.stringify(segment)}::jsonb, ${c.is_active}, ${s.staff.id}) returning id`.execute(
          trx,
        );
        id = r.rows[0]!.id;
      }
    });
  } catch (e) {
    console.error("[cupones] guardar falló", e);
    const m = dbErrorMessage(e);
    return { error: m.code === "23505" ? "Ya existe un cupón con ese código" : m.message };
  }
  revalidatePath("/cupones");
  revalidatePath(`/cupones/${id}`);
  redirect(`/cupones/${id}?guardado=1`);
}

export async function setCouponActiveAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = z
    .object({ id: uuid, active: z.enum(["1", "0"]) })
    .safeParse({ id: str(fd, "id"), active: str(fd, "active") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`update coupons set is_active = ${p.data.active === "1"} where id = ${p.data.id}`.execute(
        trx,
      ),
    );
    revalidatePath("/cupones");
    revalidatePath(`/cupones/${p.data.id}`);
    return { ok: p.data.active === "1" ? "Cupón activado" : "Cupón desactivado" };
  } catch (e) {
    console.error("[cupones] activar falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

const genSchema = z.object({
  id: uuid,
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,12}$/, "Prefijo: 2–12 letras/números"),
  count: z.number().int().min(1).max(200),
  max_uses: z.number().int().min(1).max(10000),
});

/** Genera N cupones de un solo uso (o max_uses) copiando la configuración del cupón base. */
export async function generateCodesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("loyalty.write");
  const p = genSchema.safeParse({
    id: str(fd, "id"),
    prefix: str(fd, "prefix"),
    count: num(fd, "count"),
    max_uses: num(fd, "max_uses") ?? 1,
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const g = p.data;
  try {
    const codes = await withStaff(db(), s.staff.id, async (trx) => {
      const r = await sql<{ code: string }>`
        insert into coupons(code, name, kind, value_bps, value_cents, product_id, min_subtotal_cents, starts_at, ends_at, max_uses, max_uses_per_customer, channels, segment, is_active, created_by)
        select ${g.prefix} || '-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6)), coalesce(b.name, b.code::text) || ' (lote ' || ${g.prefix} || ')', b.kind, b.value_bps, b.value_cents, b.product_id,
               b.min_subtotal_cents, b.starts_at, b.ends_at, ${g.max_uses}, b.max_uses_per_customer, b.channels, b.segment, true, ${s.staff.id}
        from coupons b, generate_series(1, ${g.count}) where b.id = ${g.id}
        returning code::text as code`.execute(trx);
      return r.rows.map((x) => x.code);
    });
    revalidatePath("/cupones");
    return { ok: `${codes.length} códigos generados con prefijo ${g.prefix}`, data: { codes } };
  } catch (e) {
    console.error("[cupones] generar falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

const testSchema = z.object({
  code: z.string().trim().min(1, "Escribe el código").max(40),
  customer: z.string().trim().max(80).optional(),
  subtotal_cents: z.number().int().min(0),
  channel: z.enum(["pos", "web"]),
  product_id: uuid.optional(),
  qty: z.number().int().min(1).max(999),
});

export async function testCouponAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireSession("customers.read");
  const p = testSchema.safeParse({
    code: str(fd, "code"),
    customer: optStr(fd, "customer"),
    subtotal_cents: cents(fd, "subtotal_pesos") ?? 0,
    channel: str(fd, "channel") || "pos",
    product_id: optStr(fd, "product_id"),
    qty: num(fd, "qty") ?? 1,
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const t = p.data;
  try {
    const d = db();
    let customerId: string | null = null;
    let customerName: string | null = null;
    if (t.customer) {
      const c = await sql<{
        id: string;
        full_name: string;
      }>`select id, full_name from find_customer(${t.customer})`.execute(d);
      if (!c.rows[0])
        return {
          error: `No se encontró el cliente "${t.customer}" (usa código PDP-…, teléfono o email)`,
        };
      customerId = c.rows[0].id;
      customerName = c.rows[0].full_name;
    }
    let items: Array<Record<string, unknown>> = [];
    let subtotal = t.subtotal_cents;
    if (t.product_id) {
      const pr = await sql<{
        price: number | null;
        name: string;
      }>`select current_price_cents(id, ${t.channel}::price_channel) as price, name from products where id = ${t.product_id}`.execute(
        d,
      );
      const price = pr.rows[0]?.price ?? 0;
      items = [
        {
          product_id: t.product_id,
          qty: t.qty,
          unit_price_cents: price,
          total_cents: price * t.qty,
        },
      ];
      if (subtotal === 0) subtotal = price * t.qty;
    }
    const res = await callFn<{
      valid: boolean;
      reason?: string;
      discount_cents?: number;
      kind?: string;
      code?: string;
      min_subtotal_cents?: number;
    }>(d, "validate_coupon", [t.code, customerId, subtotal, t.channel, JSON.stringify(items)]);
    return {
      ok: res.valid
        ? `Válido: descuento de $${((res.discount_cents ?? 0) / 100).toFixed(2)} sobre $${(subtotal / 100).toFixed(2)}`
        : undefined,
      error: res.valid
        ? undefined
        : `No aplica: ${VALIDATE_REASONS[res.reason ?? ""] ?? res.reason}${res.reason === "min_subtotal" && res.min_subtotal_cents ? ` ($${(res.min_subtotal_cents / 100).toFixed(2)})` : ""}`,
      data: { ...res, subtotal_cents: subtotal, customer_name: customerName },
    };
  } catch (e) {
    console.error("[cupones] probar falló", e);
    return { error: dbErrorMessage(e).message };
  }
}
