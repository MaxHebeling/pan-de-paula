"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  customerRegistrationWithEmailSchema,
  emailSchema,
  parseOptionalPhone,
  phoneMX,
} from "@pdp/domain";
import { createCustomerAccessToken } from "@pdp/auth/customer";
import { isEmailConfigured, sendPortalAccessEmail } from "@pdp/integrations";
import { requireSession, clientIp } from "@/lib/auth";
import { db, sql, callFn, withStaff, dbErrorMessage } from "@/lib/db";
import { bool, optStr, str, type ActionState } from "@/lib/action-state";

const uuid = z.string().uuid();

const tagsSchema = z
  .string()
  .max(300)
  .transform((s) =>
    Array.from(
      new Set(
        s
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    ).slice(0, 20),
  );

export async function createCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  // El servidor manda: el país del selector y el número se combinan aquí en el valor canónico
  // (10 dígitos si es México, "+<prefijo><nacional>" en el resto). Ver docs/DATABASE.md.
  const phone = parseOptionalPhone(str(fd, "phone_country"), str(fd, "phone"));
  if (!phone.ok) return { error: phone.error };
  // Alta humana desde el CRM: el correo es obligatorio (es la llave del portal del cliente).
  const parsed = customerRegistrationWithEmailSchema.safeParse({
    full_name: str(fd, "full_name"),
    phone: phone.value ?? "",
    email: str(fd, "email"),
    birthday: str(fd, "birthday"),
    marketing_consent: bool(fd, "marketing_consent"),
    source: "admin",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const extra = z
    .object({ notes: z.string().trim().max(1000).optional(), tags: tagsSchema })
    .safeParse({ notes: optStr(fd, "notes"), tags: str(fd, "tags") });
  if (!extra.success) return { error: extra.error.issues[0]?.message ?? "Datos inválidos" };
  let id: string;
  let created = true;
  try {
    const r = await withStaff(db(), s.staff.id, async (trx) => {
      const res = await callFn<{ customer_id: string; created: boolean }>(
        trx,
        "register_customer",
        [JSON.stringify({ ...parsed.data, notes: extra.data.notes })],
      );
      if (res.created && extra.data.tags.length) {
        await sql`update customers set tags = ${extra.data.tags} where id = ${res.customer_id}`.execute(
          trx,
        );
      }
      return res;
    });
    id = r.customer_id;
    created = r.created;
  } catch (e) {
    console.error("[clientes] alta falló", e);
    if ((e as { code?: string }).code === "23505")
      return { error: "Ese correo ya está registrado." };
    return { error: dbErrorMessage(e).message };
  }
  revalidatePath("/clientes");
  redirect(`/clientes/${id}${created ? "?creado=1" : "?existente=1"}`);
}

const updateSchema = z.object({
  id: uuid,
  full_name: z.string().trim().min(2, "Nombre muy corto").max(120),
  phone: phoneMX.optional().or(z.literal("").transform(() => undefined)),
  // En la edición el correo es opcional a nivel de forma: si el cliente YA tenía correo se exige más
  // abajo (no se puede borrar), y si es un cliente histórico sin correo se puede guardar el resto sin
  // quedar bloqueado. El alta sí lo exige siempre.
  email: emailSchema.optional().or(z.literal("").transform(() => undefined)),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(2000).optional(),
  tags: tagsSchema,
  marketing_consent: z.boolean(),
  operational_consent: z.boolean(),
});

export async function updateCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const phone = parseOptionalPhone(str(fd, "phone_country"), str(fd, "phone"));
  if (!phone.ok) return { error: phone.error };
  const parsed = updateSchema.safeParse({
    id: str(fd, "id"),
    full_name: str(fd, "full_name"),
    phone: phone.value ?? "",
    email: str(fd, "email"),
    birthday: str(fd, "birthday"),
    notes: str(fd, "notes"),
    tags: str(fd, "tags"),
    marketing_consent: bool(fd, "marketing_consent"),
    operational_consent: bool(fd, "operational_consent"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const d = parsed.data;
  // Un cliente que ya tiene correo no puede quedarse sin él: es su acceso al portal.
  const actual = await sql<{ email: string | null }>`
    select email::text as email from customers where id = ${d.id} and deleted_at is null`.execute(
    db(),
  );
  if (!actual.rows[0]) return { error: "Ese cliente ya no existe." };
  if (actual.rows[0].email && !d.email)
    return { error: "El correo electrónico es obligatorio: es el acceso del cliente a su portal." };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`update customers set full_name = ${d.full_name}, phone = ${d.phone ?? null}, email = ${d.email ?? null},
            birthday = ${d.birthday ?? null}, notes = ${d.notes || null}, tags = ${d.tags},
            marketing_consent = ${d.marketing_consent}, operational_consent = ${d.operational_consent},
            marketing_opt_out_at = case when ${d.marketing_consent} then null else coalesce(marketing_opt_out_at, now()) end
          where id = ${d.id} and deleted_at is null`.execute(trx),
    );
  } catch (e) {
    console.error("[clientes] edición falló", e);
    if ((e as { code?: string }).code === "23505") {
      const constraint = (e as { constraint?: string }).constraint;
      return {
        error:
          constraint === "customers_phone_idx"
            ? "Ese teléfono ya está registrado en otro cliente."
            : "Ese correo ya está registrado en otro cliente.",
      };
    }
    return { error: dbErrorMessage(e).message };
  }
  revalidatePath(`/clientes/${d.id}`);
  revalidatePath("/clientes");
  redirect(`/clientes/${d.id}?actualizado=1`);
}

export async function setMarketingConsentAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ id: uuid, value: z.enum(["on", "off"]) })
    .safeParse({ id: str(fd, "id"), value: str(fd, "value") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`update customers set marketing_consent = ${p.data.value === "on"},
            marketing_opt_out_at = case when ${p.data.value === "on"} then null else now() end
          where id = ${p.data.id}`.execute(trx),
    );
  } catch (e) {
    console.error("[clientes] consentimiento falló", e);
    return { error: dbErrorMessage(e).message };
  }
  revalidatePath(`/clientes/${p.data.id}`);
  return {
    ok:
      p.data.value === "on"
        ? "Consentimiento de marketing activado"
        : "Cliente dado de baja de marketing",
  };
}

const adjustSchema = z.object({
  id: uuid,
  points: z.coerce
    .number()
    .int("Debe ser un entero")
    .refine((n) => n !== 0, "Indica un número distinto de 0")
    .refine((n) => Math.abs(n) <= 100000, "Máximo 100,000"),
  reason: z.string().trim().min(3, "Escribe el motivo (mínimo 3 caracteres)").max(200),
});

export async function adjustPointsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = adjustSchema.safeParse({
    id: str(fd, "id"),
    points: str(fd, "points"),
    reason: str(fd, "reason"),
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const key = str(fd, "idempotency_key").slice(0, 80);
  try {
    // Regresión auditoría 360°: un doble envío (doble clic, reintento de red) sumaba los puntos dos veces.
    // Con clave: lock transaccional por clave + registro en domain_events; la segunda llamada devuelve el saldo sin tocarlo.
    const result = await withStaff(db(), s.staff.id, async (trx) => {
      if (key) {
        await sql`select pg_advisory_xact_lock(hashtext(${"points-adjust:" + key}))`.execute(trx);
        const dup = await sql<{ n: number }>`
          select count(*)::int as n from domain_events
          where event_type = 'POINTS_ADJUSTED' and aggregate_id = ${p.data.id} and payload->>'idempotency_key' = ${key}`.execute(
          trx,
        );
        if ((dup.rows[0]?.n ?? 0) > 0) {
          const bal = await sql<{
            b: number;
          }>`select points_balance as b from customers where id = ${p.data.id}`.execute(trx);
          return { balance: bal.rows[0]?.b ?? 0, duplicate: true };
        }
      }
      const balance = await callFn<number>(trx, "loyalty_post", [
        p.data.id,
        "adjust",
        p.data.points,
        null,
        null,
        `Ajuste manual: ${p.data.reason}`,
      ]);
      await callFn(trx, "emit_event", [
        "POINTS_ADJUSTED",
        "customer",
        p.data.id,
        JSON.stringify({
          points: p.data.points,
          reason: p.data.reason,
          idempotency_key: key || null,
        }),
      ]);
      return { balance, duplicate: false };
    });
    if (!result.duplicate)
      await withStaff(db(), s.staff.id, (trx) =>
        callFn(trx, "recompute_customer_tier", [p.data.id]),
      );
    revalidatePath(`/clientes/${p.data.id}`);
    return { ok: `Puntos ajustados. Nuevo saldo: ${result.balance}` };
  } catch (e) {
    console.error("[clientes] ajuste de puntos falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function redeemRewardAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ id: uuid, reward_id: uuid })
    .safeParse({ id: str(fd, "id"), reward_id: str(fd, "reward_id") });
  if (!p.success) return { error: "Selecciona una recompensa" };
  try {
    const r = await withStaff(db(), s.staff.id, (trx) =>
      callFn<{ redemption_id: string; code: string }>(trx, "redeem_reward", [
        p.data.id,
        p.data.reward_id,
      ]),
    );
    revalidatePath(`/clientes/${p.data.id}`);
    return { ok: `Recompensa canjeada. Código ${r.code} (aplícalo en el POS)` };
  } catch (e) {
    console.error("[clientes] canje falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function mergeCustomersAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ keep_id: uuid, merge_id: uuid })
    .safeParse({ keep_id: str(fd, "keep_id"), merge_id: str(fd, "merge_id") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      callFn(trx, "merge_customers", [p.data.keep_id, p.data.merge_id]),
    );
  } catch (e) {
    console.error("[clientes] fusión falló", e);
    return { error: dbErrorMessage(e).message };
  }
  revalidatePath("/clientes");
  revalidatePath(`/clientes/${p.data.keep_id}`);
  redirect(`/clientes/${p.data.keep_id}?fusionado=1`);
}

const addressSchema = z.object({
  id: uuid,
  label: z.string().trim().max(60).optional(),
  street: z.string().trim().min(3, "Calle y número").max(200),
  neighborhood: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  postal_code: z.string().trim().max(10).optional(),
  references_note: z.string().trim().max(300).optional(),
  is_default: z.boolean(),
});

export async function addAddressAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = addressSchema.safeParse({
    id: str(fd, "id"),
    label: optStr(fd, "label"),
    street: str(fd, "street"),
    neighborhood: optStr(fd, "neighborhood"),
    city: optStr(fd, "city"),
    state: optStr(fd, "state"),
    postal_code: optStr(fd, "postal_code"),
    references_note: optStr(fd, "references_note"),
    is_default: bool(fd, "is_default"),
  });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const a = p.data;
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      if (a.is_default)
        await sql`update customer_addresses set is_default = false where customer_id = ${a.id}`.execute(
          trx,
        );
      await sql`insert into customer_addresses(customer_id, label, street, neighborhood, city, state, postal_code, references_note, is_default)
                values (${a.id}, ${a.label ?? null}, ${a.street}, ${a.neighborhood ?? null}, ${a.city ?? null}, ${a.state ?? null}, ${a.postal_code ?? null}, ${a.references_note ?? null}, ${a.is_default})`.execute(
        trx,
      );
    });
    revalidatePath(`/clientes/${a.id}`);
    return { ok: "Dirección agregada" };
  } catch (e) {
    console.error("[clientes] dirección falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function deleteAddressAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ id: uuid, address_id: uuid })
    .safeParse({ id: str(fd, "id"), address_id: str(fd, "address_id") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`delete from customer_addresses where id = ${p.data.address_id} and customer_id = ${p.data.id}`.execute(
        trx,
      ),
    );
    revalidatePath(`/clientes/${p.data.id}`);
    return { ok: "Dirección eliminada" };
  } catch (e) {
    console.error("[clientes] borrar dirección falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function markEventHandledAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ id: uuid, event_id: z.coerce.number().int().positive() })
    .safeParse({ id: str(fd, "id"), event_id: str(fd, "event_id") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`update customer_events set handled_at = now() where id = ${p.data.event_id} and customer_id = ${p.data.id} and handled_at is null`.execute(
        trx,
      ),
    );
    revalidatePath(`/clientes/${p.data.id}`);
    return { ok: "Evento atendido" };
  } catch (e) {
    console.error("[clientes] evento falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

/**
 * Genera un enlace de acceso al portal del cliente (`/portal`) para dárselo en el mostrador o por
 * WhatsApp. Mismo patrón que el restablecimiento de contraseña del staff y que el saludo de cumpleaños:
 * el sistema prepara, una persona con permiso aprueba y entrega.
 *
 * Existe porque HOY el proveedor de correo (Resend) no está configurado en producción: sin esto, un
 * cliente que no puede recibir el correo se quedaría fuera de su propia cuenta. Si el correo sí está
 * configurado y el cliente tiene uno, además se lo enviamos.
 *
 * El enlace se devuelve en `data` (no se guarda en claro en ningún lado) y queda auditado en
 * `audit_logs` como CUSTOMER_ACCESS_LINK con el staff que lo generó.
 */
export async function generatePortalLinkAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z.object({ id: uuid }).safeParse({ id: str(fd, "id") });
  if (!p.success) return { error: "Datos inválidos" };
  const c = await sql<{
    id: string;
    full_name: string;
    email: string | null;
  }>`select id, full_name, email from customers
      where id = ${p.data.id} and deleted_at is null and merged_into_id is null`.execute(db());
  const customer = c.rows[0];
  if (!customer) return { error: "El cliente no existe." };

  let link: string;
  let minutes: number;
  try {
    const ip = await clientIp();
    const r = await withStaff(db(), s.staff.id, (trx) =>
      createCustomerAccessToken(trx, {
        customerId: customer.id,
        requestedBy: "staff",
        staffId: s.staff.id,
        ip,
      }),
    );
    const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    link = `${base}/portal/acceso?t=${encodeURIComponent(r.token)}`;
    minutes = Math.max(1, Math.round((r.expiresAt.getTime() - Date.now()) / 60_000));
  } catch (e) {
    console.error("[clientes] no se pudo generar el enlace del portal", e);
    return { error: dbErrorMessage(e).message };
  }

  let mailed = false;
  if (customer.email && isEmailConfigured()) {
    const biz = await sql<{
      name: string;
    }>`select name from business_settings where id = 1`.execute(db());
    const r = await sendPortalAccessEmail(customer.email, {
      businessName: biz.rows[0]?.name ?? "El Pan de Paula",
      firstName: customer.full_name.split(/\s+/)[0] ?? customer.full_name,
      link,
      minutes,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    });
    mailed = Boolean(r.sent);
    if (!r.sent) console.error("[clientes] el enlace del portal no se pudo enviar", r.error);
  }

  revalidatePath(`/clientes/${customer.id}`);
  return {
    ok: mailed
      ? `Enlace enviado a ${customer.email}. Vence en ${minutes} minutos y sirve una sola vez; cópialo abajo si además quieres dárselo a mano.`
      : `Enlace listo. Vence en ${minutes} minutos y sirve una sola vez: compártelo solo con el cliente.`,
    data: { link, minutes, mailed },
  };
}
