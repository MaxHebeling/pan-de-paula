"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { birthdayGreetingSubject } from "@pdp/domain";
import { isEmailConfigured, sendBirthdayGreetingEmail } from "@pdp/integrations";
import { requireSession } from "@/lib/auth";
import { db, sql, withStaff, dbErrorMessage } from "@/lib/db";
import { str, type ActionState } from "@/lib/action-state";
import { birthdayContext, greetingTextFor, CHANNEL_LABELS } from "@/lib/birthdays";
import { fmtDate } from "@/lib/format";

const uuid = z.string().uuid();
const CHANNELS = ["whatsapp", "email", "manual"] as const;

/**
 * Flujo del saludo de cumpleaños (sin canal automático: el envío siempre lo aprueba una persona).
 *
 *   DETECCIÓN   cron diario → customer_events(kind='birthday')   [ya existía]
 *   GENERACIÓN  prepareGreetingAction → fila en birthday_greetings con el texto
 *   PREVISUALIZACIÓN  /clientes/[id]/cumpleanos (tarjeta + texto)
 *   APROBACIÓN  sendGreetingAction(channel) → sent_at/sent_by/channel + customer_events.handled_at
 *
 * Idempotencia: la clave primaria (customer_id, year) impide un segundo saludo del mismo año y el
 * `update … where sent_at is null` impide un segundo envío. Dos clics no generan dos filas ni dos envíos.
 */

function revalidate(customerId: string) {
  revalidatePath(`/clientes/${customerId}/cumpleanos`);
  revalidatePath(`/clientes/${customerId}`);
  revalidatePath("/fidelizacion");
}

/** Crea (o recupera) la fila del saludo del año en curso con el texto propuesto. */
export async function prepareGreetingAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z.object({ id: uuid }).safeParse({ id: str(fd, "id") });
  if (!p.success) return { error: "Datos inválidos" };
  const ctx = await birthdayContext(p.data.id);
  if (!ctx) return { error: "El cliente no existe o no tiene fecha de nacimiento registrada." };
  if (ctx.greeting) return { ok: "El saludo de este año ya estaba preparado." };
  const message = greetingTextFor(ctx);
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`insert into birthday_greetings(customer_id, year, birthday_date, tier_key, message, generated_by)
          values (${p.data.id}, ${ctx.year}, ${ctx.celebrates_on}::date, ${ctx.customer.tier_key}, ${message}, ${s.staff.id})
          on conflict (customer_id, year) do nothing`.execute(trx),
    );
  } catch (e) {
    console.error("[cumpleaños] preparar saludo falló", e);
    return { error: dbErrorMessage(e).message };
  }
  revalidate(p.data.id);
  return { ok: "Saludo preparado. Revisa el texto y envíalo cuando quieras." };
}

/**
 * Registra el envío del saludo por el canal indicado (y lo envía de verdad si el canal es correo).
 * WhatsApp y "en persona" solo registran: el mensaje lo manda el staff desde su propio teléfono.
 */
export async function sendGreetingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("customers.write");
  const p = z
    .object({ id: uuid, channel: z.enum(CHANNELS) })
    .safeParse({ id: str(fd, "id"), channel: str(fd, "channel") });
  if (!p.success) return { error: "Datos inválidos" };
  const { id, channel } = p.data;
  const ctx = await birthdayContext(id);
  if (!ctx) return { error: "El cliente no existe o no tiene fecha de nacimiento registrada." };

  // Segundo saludo al mismo cliente: se corta aquí (y de nuevo en el UPDATE, por si hay carrera).
  if (ctx.greeting?.sent_at) {
    return {
      ok: `Este saludo ya se había enviado el ${fmtDate(ctx.greeting.sent_at, "datetime")} por ${
        CHANNEL_LABELS[ctx.greeting.channel ?? ""] ?? ctx.greeting.channel
      }. No se envía dos veces.`,
    };
  }
  const message = greetingTextFor(ctx);

  if (channel === "email") {
    if (!isEmailConfigured())
      return {
        error:
          "El correo no está configurado en este ambiente (faltan RESEND_API_KEY y EMAIL_FROM). Usa WhatsApp o márcalo como entregado en persona.",
      };
    if (!ctx.customer.email)
      return { error: "El cliente no tiene correo registrado. Usa WhatsApp o regístralo primero." };
    // Clave de idempotencia por cliente y año: Resend deduplica 24 h si el envío se reintenta.
    const r = await sendBirthdayGreetingEmail(ctx.customer.email, {
      businessName: ctx.business.name,
      message,
      tierName: ctx.customer.tier_name,
      subject: birthdayGreetingSubject({
        fullName: ctx.customer.full_name,
        businessName: ctx.business.name,
      }),
      idempotencyKey: `birthday:${id}:${ctx.year}`,
    });
    if (!r.sent) {
      console.error("[cumpleaños] envío por correo falló", { customer: id, error: r.error });
      return { error: `No se pudo enviar el correo: ${r.error ?? "proveedor no disponible"}` };
    }
  }

  try {
    const done = await withStaff(db(), s.staff.id, async (trx) => {
      // Una sola sentencia: genera la fila si faltaba y la marca como enviada solo si no lo estaba.
      const r = await sql<{ customer_id: string }>`
        insert into birthday_greetings(customer_id, year, birthday_date, tier_key, message, generated_by, sent_at, sent_by, channel)
        values (${id}, ${ctx.year}, ${ctx.celebrates_on}::date, ${ctx.customer.tier_key}, ${message}, ${s.staff.id}, now(), ${s.staff.id}, ${channel})
        on conflict (customer_id, year) do update
          set sent_at = now(), sent_by = ${s.staff.id}, channel = ${channel}
          where birthday_greetings.sent_at is null
        returning customer_id`.execute(trx);
      if (r.rows.length === 0) return false;
      // El evento del día queda "gestionado" para que no siga apareciendo como pendiente.
      await sql`update customer_events set handled_at = now()
                where customer_id = ${id} and kind = 'birthday' and handled_at is null
                  and (payload->>'date')::date = ${ctx.celebrates_on}::date`.execute(trx);
      return true;
    });
    revalidate(id);
    return done
      ? { ok: `Saludo registrado como enviado por ${CHANNEL_LABELS[channel]}.` }
      : { ok: "Este saludo ya estaba registrado como enviado. No se envía dos veces." };
  } catch (e) {
    console.error("[cumpleaños] registrar envío falló", e);
    return { error: dbErrorMessage(e).message };
  }
}
