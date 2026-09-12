import "server-only";
import { db, sql } from "./db";

export type ConversationRow = {
  id: string;
  ig_user_id: string;
  ig_username: string | null;
  status: "open" | "handled" | "converted" | "closed";
  last_message_at: Date | null;
  last_intent: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  public_code: string | null;
  last_text: string | null;
  last_direction: string | null;
  unanswered: boolean;
  pending_out: number;
  messages: number;
  created_at: Date;
};

const LIST = sql`
  select c.id, c.ig_user_id, c.ig_username, c.status, c.last_message_at, c.last_intent, c.assigned_to, su.full_name as assigned_name,
         c.customer_id, cu.full_name as customer_name, cu.public_code, c.created_at,
         lm.text as last_text, lm.direction as last_direction,
         (lm.direction = 'in') as unanswered,
         (select count(*) from instagram_messages m where m.conversation_id = c.id and m.delivery_status = 'pending')::int as pending_out,
         (select count(*) from instagram_messages m where m.conversation_id = c.id)::int as messages
  from instagram_conversations c
  left join staff_users su on su.id = c.assigned_to
  left join customers cu on cu.id = c.customer_id
  left join lateral (select text, direction from instagram_messages m where m.conversation_id = c.id order by created_at desc limit 1) lm on true`;

export async function listConversations(opts: { status?: string; q?: string; mine?: string } = {}) {
  const conds = [sql`true`];
  if (opts.status && opts.status !== "all") conds.push(sql`c.status = ${opts.status}`);
  if (opts.q) conds.push(sql`(c.ig_username ilike ${"%" + opts.q + "%"} or cu.full_name ilike ${"%" + opts.q + "%"} or exists (select 1 from instagram_messages m where m.conversation_id = c.id and m.text ilike ${"%" + opts.q + "%"}))`);
  if (opts.mine) conds.push(sql`c.assigned_to = ${opts.mine}`);
  const r = await sql<ConversationRow>`${LIST} where ${sql.join(conds, sql` and `)} order by c.last_message_at desc nulls last limit 200`.execute(db());
  return r.rows;
}

export async function getConversation(id: string) {
  const [c, m] = await Promise.all([
    sql<ConversationRow>`${LIST} where c.id = ${id}`.execute(db()),
    sql<{
      id: string;
      direction: "in" | "out";
      text: string | null;
      attachments: unknown;
      intent: string | null;
      auto_reply: boolean;
      sent_by_name: string | null;
      delivery_status: "sent" | "pending" | "failed";
      delivery_error: string | null;
      created_at: Date;
    }>`select m.id, m.direction, m.text, m.attachments, m.intent, m.auto_reply, su.full_name as sent_by_name, m.delivery_status, m.delivery_error, m.created_at
       from instagram_messages m left join staff_users su on su.id = m.sent_by
       where m.conversation_id = ${id} order by m.created_at asc limit 500`.execute(db()),
  ]);
  return c.rows[0] ? { conversation: c.rows[0], messages: m.rows } : null;
}

export async function conversationLeads(conversationId: string) {
  const r = await sql<LeadRow>`${LEADS} where l.source_ref = ${conversationId} order by l.created_at desc`.execute(db());
  return r.rows;
}

export type LeadRow = {
  id: string;
  source: string;
  source_ref: string | null;
  name: string | null;
  handle: string | null;
  phone: string | null;
  email: string | null;
  interest: string | null;
  product_id: string | null;
  product_name: string | null;
  link_sent: string | null;
  status: "new" | "contacted" | "converted" | "lost";
  customer_id: string | null;
  customer_name: string | null;
  order_id: string | null;
  folio: string | null;
  converted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const LEADS = sql`
  select l.id, l.source, l.source_ref, l.name, l.handle, l.phone, l.email::text as email, l.interest, l.product_id, p.name as product_name, l.link_sent,
         l.status, l.customer_id, c.full_name as customer_name, l.order_id, o.folio, l.converted_at, l.created_at, l.updated_at
  from leads l
  left join products p on p.id = l.product_id
  left join customers c on c.id = l.customer_id
  left join orders o on o.id = l.order_id`;

export async function listLeads(opts: { status?: string; source?: string } = {}) {
  const conds = [sql`true`];
  if (opts.status) conds.push(sql`l.status = ${opts.status}`);
  if (opts.source) conds.push(sql`l.source = ${opts.source}`);
  const r = await sql<LeadRow>`${LEADS} where ${sql.join(conds, sql` and `)} order by (l.status = 'new') desc, l.created_at desc limit 300`.execute(db());
  return r.rows;
}

export async function instagramMetrics() {
  const d = db();
  const [weeks, totals, intents] = await Promise.all([
    sql<{ week: string; inbound: number; conversations: number; converted: number }>`
      with bs as (select timezone as tz from business_settings where id = 1),
      w as (select generate_series(date_trunc('week', (now() at time zone (select tz from bs))::date) - interval '7 weeks', date_trunc('week', (now() at time zone (select tz from bs))::date), interval '1 week')::date as week)
      select to_char(w.week, 'YYYY-MM-DD') as week,
             (select count(*) from instagram_messages m, bs where m.direction = 'in' and date_trunc('week', m.created_at at time zone bs.tz)::date = w.week)::int as inbound,
             (select count(distinct m.conversation_id) from instagram_messages m, bs where m.direction = 'in' and date_trunc('week', m.created_at at time zone bs.tz)::date = w.week)::int as conversations,
             (select count(*) from instagram_conversations c, bs where c.status = 'converted' and date_trunc('week', c.updated_at at time zone bs.tz)::date = w.week)::int as converted
      from w order by w.week`.execute(d),
    sql<{ open: number; unanswered: number; total: number; converted: number; leads_new: number; leads_total: number; leads_converted: number; pending_out: number; avg_first_reply_min: number | null }>`
      select (select count(*) from instagram_conversations where status = 'open')::int as open,
             (select count(*) from instagram_conversations c where c.status in ('open','handled') and (select direction from instagram_messages m where m.conversation_id = c.id order by created_at desc limit 1) = 'in')::int as unanswered,
             (select count(*) from instagram_conversations)::int as total,
             (select count(*) from instagram_conversations where status = 'converted')::int as converted,
             (select count(*) from leads where status = 'new')::int as leads_new,
             (select count(*) from leads)::int as leads_total,
             (select count(*) from leads where status = 'converted')::int as leads_converted,
             (select count(*) from instagram_messages where delivery_status = 'pending')::int as pending_out,
             (select round(avg(extract(epoch from (fo.t - fi.t)) / 60))::int
                from (select conversation_id, min(created_at) t from instagram_messages where direction = 'in' group by conversation_id) fi
                join (select conversation_id, min(created_at) t from instagram_messages where direction = 'out' group by conversation_id) fo on fo.conversation_id = fi.conversation_id
               where fo.t > fi.t) as avg_first_reply_min`.execute(d),
    sql<{ intent: string; n: number }>`select coalesce(last_intent, 'sin clasificar') as intent, count(*)::int as n from instagram_conversations group by 1 order by 2 desc limit 8`.execute(d),
  ]);
  return { weeks: weeks.rows, totals: totals.rows[0]!, intents: intents.rows };
}

export const CONV_STATUS: Record<string, { label: string; tone: "green" | "blue" | "amber" | "gray" }> = {
  open: { label: "abierta", tone: "amber" },
  handled: { label: "atendida", tone: "blue" },
  converted: { label: "convertida", tone: "green" },
  closed: { label: "cerrada", tone: "gray" },
};
export const LEAD_STATUS: Record<string, { label: string; tone: "green" | "blue" | "amber" | "gray" | "red" }> = {
  new: { label: "nuevo", tone: "amber" },
  contacted: { label: "contactado", tone: "blue" },
  converted: { label: "convertido", tone: "green" },
  lost: { label: "perdido", tone: "red" },
};
