/**
 * Notificaciones push al teléfono del cliente (Web Push estándar, con VAPID).
 *
 * Por qué Web Push y no Firebase: es lo que ya hablan Chrome, Edge, Firefox y Safari (iOS 16.4+)
 * sin meter otro servicio, otra cuenta ni otro SDK en el navegador. El servidor firma con un par de
 * claves VAPID propias y el navegador cifra el contenido con las claves que él mismo dio al
 * suscribirse. Nada de esto sale en logs.
 *
 * El aviso ya existe en `customer_notifications` (lo crea la base al cambiar el estado del pedido,
 * migración 0046). Aquí solo se ENTREGA, y se entrega una sola vez: quien va a enviar RECLAMA el
 * aviso con un update condicional sobre `pushed_at`, así que si el cron y la acción del CRM
 * coinciden, o un reintento repite la llamada, el segundo no encuentra nada que reclamar.
 */
import webpush, { type PushSubscription, WebPushError } from "web-push";
import { sql, type Database, type DB, type Transaction } from "@pdp/db";
import { logger } from "./logger.ts";

const log = logger.child("push");

type Exec = Database | Transaction<DB>;

/** Claves VAPID del servidor. La pública también viaja al navegador (no es un secreto). */
export function pushConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:hola@pandepaula.com";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

export const isPushConfigured = (): boolean => pushConfig() !== null;

/** Genera un par VAPID nuevo (para configurar el proyecto una sola vez). */
export const generateVapidKeys = (): { publicKey: string; privateKey: string } =>
  webpush.generateVAPIDKeys();

export type PushPayload = {
  title: string;
  body: string;
  /** A dónde lleva al tocarla (ruta del portal). */
  url: string;
  /** Agrupa notificaciones del mismo pedido: la nueva sustituye a la anterior en la pantalla. */
  tag?: string;
};

type Subscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const toWebPush = (s: Subscription): PushSubscription => ({
  endpoint: s.endpoint,
  keys: { p256dh: s.p256dh, auth: s.auth },
});

/**
 * Envía a UN dispositivo. Devuelve `gone: true` cuando el navegador dice que esa suscripción ya no
 * existe (404/410): el dispositivo se desinstaló, se limpiaron los datos o el permiso se revocó.
 */
async function sendOne(
  sub: Subscription,
  payload: PushPayload,
): Promise<{ sent: boolean; gone: boolean; error?: string }> {
  const cfg = pushConfig();
  if (!cfg) return { sent: false, gone: false, error: "not_configured" };
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  try {
    await webpush.sendNotification(toWebPush(sub), JSON.stringify(payload), {
      TTL: 60 * 60, // una hora: si el teléfono está apagado más que eso, el aviso ya no es noticia
      urgency: "high",
    });
    return { sent: true, gone: false };
  } catch (e: unknown) {
    if (e instanceof WebPushError) {
      const gone = e.statusCode === 404 || e.statusCode === 410;
      // El cuerpo del error del servicio de push puede traer el endpoint: se guarda solo el código.
      return { sent: false, gone, error: `push_${e.statusCode}` };
    }
    return { sent: false, gone: false, error: (e as Error).message.slice(0, 200) };
  }
}

/** Suscripciones vivas de un cliente. */
async function subscriptionsOf(db: Exec, customerId: string): Promise<Subscription[]> {
  const r = await sql<Subscription>`
    select id, endpoint, p256dh, auth from push_subscriptions
     where customer_id = ${customerId} and disabled_at is null`.execute(db);
  return r.rows;
}

/** Marca una suscripción como muerta (el navegador ya no la reconoce). */
async function disable(db: Exec, id: string, reason: string): Promise<void> {
  await sql`update push_subscriptions set disabled_at = now(), fail_count = fail_count + 1
             where id = ${id} and disabled_at is null`.execute(db);
  log.info("suscripción desactivada", { subscription_id: id, reason });
}

export type PushOutcome = { claimed: number; sent: number; failed: number; disabled: number };

/**
 * Entrega los avisos pendientes por push.
 *
 * `orderId` acota a un pedido (lo llama el CRM justo después de mover el estado, para que el push
 * salga en el acto). Sin él recorre la cola, que es lo que hace el cron como red de seguridad para
 * los cambios que no pasan por una acción del CRM (por ejemplo, un pago confirmado por webhook).
 *
 * Solo entran avisos RECIENTES: si el servicio estuvo caído dos horas, nadie quiere despertar con el
 * aviso de un pedido que ya recogió.
 */
export async function deliverPendingPushes(
  db: Database,
  opts: { orderId?: string; limit?: number; maxAgeMinutes?: number } = {},
): Promise<PushOutcome> {
  const out: PushOutcome = { claimed: 0, sent: 0, failed: 0, disabled: 0 };
  if (!isPushConfigured()) return out;
  const limit = opts.limit ?? 50;
  const maxAge = opts.maxAgeMinutes ?? 60;

  /*
   * Reclamo atómico: el mismo update que los selecciona les pone `pushed_at`, así que dos procesos
   * simultáneos no pueden llevarse el mismo aviso. `skip locked` evita que uno espere al otro.
   */
  const claimed = await sql<{
    id: string;
    customer_id: string;
    title: string;
    body: string | null;
    kind: string;
    folio: string | null;
  }>`
    with candidatos as (
      select n.id
        from customer_notifications n
        join orders o on o.id = n.order_id
       where n.pushed_at is null
         and n.created_at > now() - (${maxAge} || ' minutes')::interval
         and (${opts.orderId ?? null}::uuid is null or n.order_id = ${opts.orderId ?? null}::uuid)
         and (select order_updates from customer_prefs(n.customer_id))
         and exists (select 1 from push_subscriptions p
                      where p.customer_id = n.customer_id and p.disabled_at is null)
       order by n.created_at
       limit ${limit}
       for update of n skip locked
    )
    update customer_notifications n set pushed_at = now()
      from candidatos c
     where n.id = c.id
    returning n.id, n.customer_id::text as customer_id, n.title, n.body, n.kind,
              (select folio from orders where id = n.order_id) as folio`.execute(db);
  out.claimed = claimed.rows.length;

  for (const aviso of claimed.rows) {
    const subs = await subscriptionsOf(db, aviso.customer_id);
    if (subs.length === 0) continue;
    const payload: PushPayload = {
      title: aviso.title,
      body: aviso.body ?? "",
      url: aviso.folio ? `/portal/pedidos/${aviso.folio}` : "/portal/avisos",
      tag: aviso.folio ?? aviso.kind,
    };
    let algunoLlegó = false;
    const errores: string[] = [];
    for (const s of subs) {
      const r = await sendOne(s, payload);
      if (r.sent) {
        algunoLlegó = true;
        await sql`update push_subscriptions set last_used_at = now(), fail_count = 0
                   where id = ${s.id}`.execute(db);
      } else if (r.gone) {
        await disable(db, s.id, r.error ?? "gone");
        out.disabled += 1;
        // También cuenta como motivo: si TODOS los dispositivos estaban muertos, el aviso no salió
        // por eso y no por "no tenía dispositivos", que sería engañoso al revisarlo después.
        errores.push(r.error ?? "gone");
      } else if (r.error) {
        errores.push(r.error);
        await sql`update push_subscriptions set fail_count = fail_count + 1 where id = ${s.id}`.execute(
          db,
        );
      }
    }
    if (algunoLlegó) out.sent += 1;
    else {
      out.failed += 1;
      // Queda escrito POR QUÉ no salió, sin guardar endpoints ni claves.
      await sql`update customer_notifications set push_error = ${errores.join(",").slice(0, 200) || "sin dispositivos"}
                 where id = ${aviso.id}`.execute(db);
    }
  }
  if (out.claimed > 0) log.info("push entregado", { ...out });
  return out;
}

/**
 * Guarda (o refresca) la suscripción de un dispositivo. Idempotente por `endpoint`: volver a
 * suscribirse en el mismo navegador actualiza el renglón y lo reactiva, no crea otro.
 */
export async function saveSubscription(
  db: Exec,
  input: {
    customerId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  },
): Promise<void> {
  await sql`
    insert into push_subscriptions(customer_id, endpoint, p256dh, auth, user_agent, last_used_at)
    values (${input.customerId}, ${input.endpoint}, ${input.p256dh}, ${input.auth},
            ${input.userAgent?.slice(0, 300) ?? null}, now())
    on conflict (endpoint) do update
      set customer_id = excluded.customer_id, p256dh = excluded.p256dh, auth = excluded.auth,
          user_agent = excluded.user_agent, disabled_at = null, fail_count = 0, last_used_at = now()`.execute(
    db,
  );
}

/** Quita la suscripción de este dispositivo (el cliente apagó los avisos o cerró sesión). */
export async function removeSubscription(
  db: Exec,
  customerId: string,
  endpoint: string,
): Promise<void> {
  await sql`delete from push_subscriptions
             where customer_id = ${customerId} and endpoint = ${endpoint}`.execute(db);
}
