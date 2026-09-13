/**
 * Procesamiento de mensajes entrantes de Instagram: registro idempotente (webhook_events + external_mid),
 * conversación/mensaje, respuesta automática (flag `instagram_bot`) y lead.
 */
import { createHash } from "node:crypto";
import { sql, type Database } from "@pdp/db";
import {
  buildBotReply,
  createLogger,
  loadFeatureFlags,
  sendInstagramMessage,
  type BotReply,
  type IgIncomingMessage,
} from "@pdp/integrations";

const log = createLogger("webhook.instagram");
export const META_PROVIDER = "meta";

export type IgDeps = {
  reply?: (input: {
    text: string;
    siteUrl: string;
    db: Database;
    aiEnabled: boolean;
    history: Array<{ role: "user" | "assistant"; content: string }>;
  }) => Promise<BotReply>;
  send?: (input: { recipientId: string; text: string }) => Promise<{ messageId: string }>;
};

export function igEventExternalId(ev: IgIncomingMessage): string {
  if (ev.mid) return `mid:${ev.mid}`;
  const h = createHash("sha256")
    .update(`${ev.senderId}|${ev.recipientId}|${ev.timestamp ?? ""}|${ev.kind}|${ev.text ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `hash:${h}`;
}

export type IgProcessResult = {
  status: "processed" | "ignored" | "failed";
  reason?: string;
  eventId?: string;
};

/** Un evento `received`/`processing` sin avance en este tiempo se considera huérfano (función muerta) y se retoma. */
export const IG_STALE_PROCESSING_MS = 10 * 60_000;

/**
 * Registra el evento; si ya existía procesado/ignorado o en curso devuelve null. Un `failed` (Meta reintenta)
 * o un `received`/`processing` huérfano vuelve a `received` para reprocesarse.
 */
async function recordEvent(
  db: Database,
  ev: IgIncomingMessage,
  signatureValid: boolean | null,
): Promise<{ id: string } | null> {
  const externalId = igEventExternalId(ev);
  const ins = await sql<{ id: string }>`
    insert into webhook_events(provider, external_id, event_type, payload, signature_valid)
    values (${META_PROVIDER}, ${externalId}, ${ev.isEcho ? "message_echo" : ev.kind}, ${JSON.stringify(ev)}::jsonb, ${signatureValid})
    on conflict (provider, external_id) do nothing
    returning id
  `.execute(db);
  if (ins.rows[0]) return ins.rows[0];
  const claim = await sql<{ id: string }>`
    update webhook_events set status = 'received'
    where provider = ${META_PROVIDER} and external_id = ${externalId}
      and (status = 'failed'
           or (status in ('received','processing')
               and coalesce(last_attempt_at, received_at) < now() - make_interval(secs => ${IG_STALE_PROCESSING_MS / 1000})))
    returning id
  `.execute(db);
  return claim.rows[0] ?? null;
}

export async function processInstagramEvent(
  db: Database,
  ev: IgIncomingMessage,
  opts: { siteUrl: string; signatureValid: boolean | null; deps?: IgDeps },
): Promise<IgProcessResult> {
  if (ev.kind !== "message" && ev.kind !== "postback")
    return { status: "ignored", reason: ev.kind };
  if (ev.isDeleted) return { status: "ignored", reason: "deleted" };
  const rec = await recordEvent(db, ev, opts.signatureValid);
  if (!rec) return { status: "ignored", reason: "duplicate" };
  const eventId = rec.id;
  await sql`update webhook_events set status = 'processing', attempts = attempts + 1, last_attempt_at = now() where id = ${eventId}`.execute(
    db,
  );

  try {
    if (ev.isEcho) {
      // Mensaje enviado por la cuenta (bot o manual desde la app): lo guardamos como saliente si no existe.
      await storeEcho(db, ev);
      await finish(db, eventId, "processed");
      return { status: "processed", eventId };
    }

    const { conversationId, previous } = await storeIncoming(db, ev);

    const flags = await loadFeatureFlags(db, ["instagram_bot", "instagram_ai_replies"]);
    if (!flags.instagram_bot || !ev.text?.trim()) {
      await finish(db, eventId, "processed");
      return {
        status: "processed",
        eventId,
        reason: flags.instagram_bot ? "sin texto" : "bot desactivado",
      };
    }

    const reply = await (opts.deps?.reply ?? buildBotReply)({
      text: ev.text,
      siteUrl: opts.siteUrl,
      db,
      aiEnabled: Boolean(flags.instagram_ai_replies),
      history: previous,
    });
    const sent = await (opts.deps?.send ?? sendInstagramMessage)({
      recipientId: ev.senderId,
      text: reply.text,
    });

    await sql`
      insert into instagram_messages(conversation_id, external_mid, direction, text, intent, auto_reply)
      values (${conversationId}, ${sent.messageId || null}, 'out', ${reply.text}, ${reply.intent}, true)
      on conflict (external_mid) do nothing
    `.execute(db);
    await sql`
      update instagram_conversations set last_intent = ${reply.intent}, last_message_at = now() where id = ${conversationId}
    `.execute(db);
    await upsertLead(db, conversationId, ev.senderId, reply);
    await sql`update instagram_messages set intent = ${reply.intent} where external_mid = ${ev.mid} and direction = 'in' and intent is null`.execute(
      db,
    );

    await finish(db, eventId, "processed");
    log.info("respuesta automática enviada", {
      conversationId,
      intent: reply.intent,
      ai: reply.ai,
    });
    return { status: "processed", eventId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update webhook_events set status = 'failed', last_error = ${message.slice(0, 2000)} where id = ${eventId}`
      .execute(db)
      .catch((err) => log.error("no se pudo marcar el evento meta como failed", { eventId, err }));
    log.error("fallo al procesar mensaje de Instagram", { eventId, err: e });
    return { status: "failed", eventId, reason: message };
  }
}

async function finish(db: Database, eventId: string, status: "processed" | "ignored") {
  await sql`update webhook_events set status = ${status}, processed_at = now(), last_error = null where id = ${eventId}`.execute(
    db,
  );
}

async function storeIncoming(db: Database, ev: IgIncomingMessage) {
  const conv = await sql<{ id: string }>`
    insert into instagram_conversations(ig_user_id, last_message_at, status)
    values (${ev.senderId}, now(), 'open')
    on conflict (ig_user_id) do update
      set last_message_at = now(),
          status = case when instagram_conversations.status in ('closed','handled') then 'open' else instagram_conversations.status end
    returning id
  `.execute(db);
  const conversationId = conv.rows[0]!.id;
  const history = await sql<{ direction: "in" | "out"; text: string | null }>`
    select direction, text from instagram_messages where conversation_id = ${conversationId} and text is not null
    order by created_at desc limit 6
  `.execute(db);
  await sql`
    insert into instagram_messages(conversation_id, external_mid, direction, text, attachments)
    values (${conversationId}, ${ev.mid}, 'in', ${ev.text}, ${JSON.stringify(ev.attachments)}::jsonb)
    on conflict (external_mid) do nothing
  `.execute(db);
  const previous = history.rows.reverse().map((m) => ({
    role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
    content: m.text ?? "",
  }));
  return { conversationId, previous };
}

async function storeEcho(db: Database, ev: IgIncomingMessage) {
  // En un echo, recipient = cliente.
  const conv = await sql<{ id: string }>`
    insert into instagram_conversations(ig_user_id, last_message_at) values (${ev.recipientId}, now())
    on conflict (ig_user_id) do update set last_message_at = now() returning id
  `.execute(db);
  await sql`
    insert into instagram_messages(conversation_id, external_mid, direction, text, attachments, auto_reply)
    values (${conv.rows[0]!.id}, ${ev.mid}, 'out', ${ev.text}, ${JSON.stringify(ev.attachments)}::jsonb, false)
    on conflict (external_mid) do nothing
  `.execute(db);
}

async function upsertLead(db: Database, conversationId: string, igUserId: string, reply: BotReply) {
  const existing = await sql<{ id: string }>`
    select id from leads where source = 'instagram' and source_ref = ${conversationId} and status in ('new','contacted')
    order by created_at desc limit 1
  `.execute(db);
  if (existing.rows[0]) {
    await sql`
      update leads set interest = coalesce(${reply.leadInterest ?? null}, interest),
                       product_id = coalesce(${reply.productId ?? null}::uuid, product_id),
                       link_sent = coalesce(${reply.link ?? null}, link_sent)
      where id = ${existing.rows[0].id}
    `.execute(db);
    return;
  }
  await sql`
    insert into leads(source, source_ref, handle, interest, product_id, link_sent, status)
    values ('instagram', ${conversationId}, ${igUserId}, ${reply.leadInterest ?? reply.intent}, ${reply.productId ?? null}::uuid, ${reply.link ?? null}, 'new')
  `.execute(db);
}
