"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sendInstagramMessage, isInstagramConfigured, NotConfiguredError } from "@pdp/integrations";
import { requireSession } from "@/lib/auth";
import { db, sql, withStaff, dbErrorMessage } from "@/lib/db";
import { optStr, str, type ActionState } from "@/lib/action-state";

const uuid = z.string().uuid();
const revalidate = (id?: string) => {
  revalidatePath("/instagram");
  revalidatePath("/instagram/leads");
  if (id) revalidatePath(`/instagram/${id}`);
};

/**
 * Responde en Instagram. Si la integración no está configurada, el mensaje se guarda como saliente
 * PENDIENTE (no enviado) y se avisa claramente; si Meta rechaza, se guarda como fallido con el error.
 */
export async function replyAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z.object({ id: uuid, text: z.string().trim().min(1, "Escribe la respuesta").max(1000, "Máximo 1000 caracteres") }).safeParse({ id: str(fd, "id"), text: str(fd, "text") });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const { id, text } = p.data;
  const conv = await sql<{ ig_user_id: string; status: string }>`select ig_user_id, status from instagram_conversations where id = ${id}`.execute(db());
  const c = conv.rows[0];
  if (!c) return { error: "La conversación no existe" };

  let status: "sent" | "pending" | "failed" = "pending";
  let externalMid: string | null = null;
  let deliveryError: string | null = null;
  if (isInstagramConfigured()) {
    try {
      const r = await sendInstagramMessage({ recipientId: c.ig_user_id, text });
      status = "sent";
      externalMid = r.messageId;
    } catch (e) {
      status = e instanceof NotConfiguredError ? "pending" : "failed";
      deliveryError = (e as Error).message;
      console.error("[instagram] envío falló", { conversation: id, error: deliveryError });
    }
  }
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      await sql`insert into instagram_messages(conversation_id, external_mid, direction, text, auto_reply, sent_by, delivery_status, delivery_error)
                values (${id}, ${externalMid}, 'out', ${text}, false, ${s.staff.id}, ${status}, ${deliveryError})`.execute(trx);
      await sql`update instagram_conversations set last_message_at = now(), assigned_to = coalesce(assigned_to, ${s.staff.id}),
                status = case when status = 'open' then 'handled' else status end where id = ${id}`.execute(trx);
    });
  } catch (e) {
    console.error("[instagram] guardar respuesta falló", e);
    return { error: dbErrorMessage(e).message };
  }
  revalidate(id);
  if (status === "sent") return { ok: "Mensaje enviado" };
  if (status === "failed") return { error: `Meta rechazó el envío (${deliveryError}). El mensaje quedó registrado como fallido.` };
  return { ok: "Instagram no está conectado: la respuesta se guardó como PENDIENTE y NO se envió. Cópiala y respóndela desde la app de Instagram." };
}

export async function setConversationStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z.object({ id: uuid, status: z.enum(["open", "handled", "converted", "closed"]) }).safeParse({ id: str(fd, "id"), status: str(fd, "status") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      await sql`update instagram_conversations set status = ${p.data.status} where id = ${p.data.id}`.execute(trx);
      if (p.data.status === "converted") {
        await sql`update leads set status = 'converted', converted_at = coalesce(converted_at, now()) where source_ref = ${p.data.id} and status <> 'converted'`.execute(trx);
      }
    });
    revalidate(p.data.id);
    return { ok: "Estado actualizado" };
  } catch (e) {
    console.error("[instagram] estado falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function assignConversationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z.object({ id: uuid, staff_id: uuid.optional() }).safeParse({ id: str(fd, "id"), staff_id: optStr(fd, "staff_id") });
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) => sql`update instagram_conversations set assigned_to = ${p.data.staff_id ?? null} where id = ${p.data.id}`.execute(trx));
    revalidate(p.data.id);
    return { ok: p.data.staff_id ? "Conversación asignada" : "Asignación quitada" };
  } catch (e) {
    console.error("[instagram] asignar falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function linkCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z.object({ id: uuid, query: z.string().trim().min(3, "Escribe código PDP, teléfono o email").max(80) }).safeParse({ id: str(fd, "id"), query: str(fd, "query") });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    const c = await sql<{ id: string; full_name: string }>`select id, full_name from find_customer(${p.data.query})`.execute(db());
    if (!c.rows[0]) return { error: `No se encontró un cliente con "${p.data.query}"` };
    await withStaff(db(), s.staff.id, async (trx) => {
      await sql`update instagram_conversations set customer_id = ${c.rows[0]!.id} where id = ${p.data.id}`.execute(trx);
      await sql`update leads set customer_id = coalesce(customer_id, ${c.rows[0]!.id}) where source_ref = ${p.data.id}`.execute(trx);
    });
    revalidate(p.data.id);
    return { ok: `Vinculada a ${c.rows[0].full_name}` };
  } catch (e) {
    console.error("[instagram] vincular falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function unlinkCustomerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = uuid.safeParse(str(fd, "id"));
  if (!p.success) return { error: "Datos inválidos" };
  try {
    await withStaff(db(), s.staff.id, (trx) => sql`update instagram_conversations set customer_id = null where id = ${p.data}`.execute(trx));
    revalidate(p.data);
    return { ok: "Cliente desvinculado" };
  } catch (e) {
    console.error("[instagram] desvincular falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function createLeadAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z
    .object({
      id: uuid,
      interest: z.string().trim().min(2, "Describe el interés").max(300),
      product_id: uuid.optional(),
      name: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(20).optional(),
    })
    .safeParse({ id: str(fd, "id"), interest: str(fd, "interest"), product_id: optStr(fd, "product_id"), name: optStr(fd, "name"), phone: optStr(fd, "phone") });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const l = p.data;
  try {
    await withStaff(db(), s.staff.id, (trx) =>
      sql`insert into leads(source, source_ref, name, handle, phone, interest, product_id, customer_id)
          select 'instagram', c.id::text, coalesce(${l.name ?? null}, cu.full_name, c.ig_username), c.ig_username, coalesce(${l.phone ?? null}, cu.phone::text), ${l.interest}, ${l.product_id ?? null}, c.customer_id
          from instagram_conversations c left join customers cu on cu.id = c.customer_id where c.id = ${l.id}`.execute(trx),
    );
    revalidate(l.id);
    return { ok: "Lead creado" };
  } catch (e) {
    console.error("[instagram] crear lead falló", e);
    return { error: dbErrorMessage(e).message };
  }
}

export async function updateLeadAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const s = await requireSession("marketing.write");
  const p = z
    .object({
      id: uuid,
      status: z.enum(["new", "contacted", "converted", "lost"]),
      customer: z.string().trim().max(80).optional(),
      folio: z.string().trim().max(40).optional(),
      conversation_id: uuid.optional(),
    })
    .safeParse({ id: str(fd, "id"), status: str(fd, "status"), customer: optStr(fd, "customer"), folio: optStr(fd, "folio"), conversation_id: optStr(fd, "conversation_id") });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Datos inválidos" };
  const l = p.data;
  try {
    const d = db();
    let customerId: string | null = null;
    let orderId: string | null = null;
    if (l.customer) {
      const c = await sql<{ id: string }>`select id from find_customer(${l.customer})`.execute(d);
      if (!c.rows[0]) return { error: `No se encontró el cliente "${l.customer}"` };
      customerId = c.rows[0].id;
    }
    if (l.folio) {
      const o = await sql<{ id: string; customer_id: string | null }>`select id, customer_id from orders where folio = upper(${l.folio})`.execute(d);
      if (!o.rows[0]) return { error: `No se encontró el pedido "${l.folio}"` };
      orderId = o.rows[0].id;
      customerId = customerId ?? o.rows[0].customer_id;
    }
    await withStaff(d, s.staff.id, async (trx) => {
      await sql`update leads set status = ${l.status},
                customer_id = coalesce(${customerId}, customer_id), order_id = coalesce(${orderId}, order_id),
                converted_at = case when ${l.status} = 'converted' then coalesce(converted_at, now()) else converted_at end
                where id = ${l.id}`.execute(trx);
      if (l.status === "converted") {
        await sql`update instagram_conversations c set status = 'converted', customer_id = coalesce(c.customer_id, ${customerId})
                  from leads l where l.id = ${l.id} and l.source_ref = c.id::text`.execute(trx);
      }
    });
    revalidate(l.conversation_id);
    return { ok: "Lead actualizado" };
  } catch (e) {
    console.error("[instagram] lead falló", e);
    return { error: dbErrorMessage(e).message };
  }
}
