-- 0047_push_subscriptions.sql — Notificaciones push al teléfono del cliente (Web Push).
-- Aditiva. Rango reservado 0040–0049 (clientes/fidelización).
--
-- Tres piezas, ninguna paralela a lo que ya existe:
--   1. `push_subscriptions`: un permiso concedido en UN dispositivo. Un cliente puede tener varios
--      (iPhone, Android, computadora) y el mismo navegador puede re-suscribirse: la llave natural es
--      el `endpoint` que da el navegador, así que es único y al repetirse se actualiza, no se duplica.
--   2. `customer_notification_prefs`: qué quiere recibir. Lo OPERATIVO (su pedido) se separa de lo
--      COMERCIAL (promociones): aceptar avisos de pedidos no es consentir publicidad. El consentimiento
--      de marketing sigue viviendo donde siempre, en `customers.marketing_consent`; aquí no se duplica.
--   3. `customer_notifications.pushed_at`: el control de "ya se mandó". Es lo que hace imposible el
--      push duplicado: quien va a enviar RECLAMA el aviso con un update condicional y solo el que gana
--      envía. Si el proceso se repite (reintento, dos servidores, el cron y la acción a la vez), el
--      segundo no encuentra nada que reclamar.

-- ── 1. Suscripciones por dispositivo ────────────────────────────────────────
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  endpoint     text not null unique,
  -- Claves públicas del navegador para cifrar el mensaje (no son secretos del servidor).
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  -- El navegador caducó o revocó la suscripción (404/410 al enviar): se conserva el renglón
  -- desactivado en vez de borrarlo, para no perder el rastro de qué dispositivo dejó de responder.
  disabled_at  timestamptz,
  fail_count   integer not null default 0
);
create index push_subscriptions_customer_idx
  on push_subscriptions(customer_id) where disabled_at is null;

comment on table push_subscriptions is
  'Permiso de notificaciones concedido en un dispositivo. Único por endpoint: re-suscribirse actualiza, no duplica.';

-- ── 2. Preferencias del cliente ─────────────────────────────────────────────
create table customer_notification_prefs (
  customer_id   uuid primary key references customers(id) on delete cascade,
  -- Avisos del pedido: es lo que el cliente pidió al activar las notificaciones.
  order_updates boolean not null default true,
  -- Promociones: apagado por defecto. El consentimiento comercial real vive en
  -- customers.marketing_consent; esto solo dice si además las quiere POR PUSH.
  promotions    boolean not null default false,
  updated_at    timestamptz not null default now()
);
create trigger trg_customer_notification_prefs_updated
  before update on customer_notification_prefs
  for each row execute function set_updated_at();

comment on table customer_notification_prefs is
  'Qué avisos quiere recibir el cliente. Lo operativo (pedidos) separado de lo comercial (promociones).';

-- Preferencias efectivas, con los valores por defecto para quien nunca las tocó.
create or replace function customer_prefs(p_customer uuid)
returns table (order_updates boolean, promotions boolean)
language sql stable as $$
  select coalesce(p.order_updates, true), coalesce(p.promotions, false)
    from (select 1) z
    left join customer_notification_prefs p on p.customer_id = p_customer
$$;

-- ── 3. Control de envío (idempotencia del push) ─────────────────────────────
alter table customer_notifications
  add column if not exists pushed_at timestamptz,
  add column if not exists push_error text;

comment on column customer_notifications.pushed_at is
  'Momento en que se RECLAMÓ el aviso para mandarlo por push. Se fija con un update condicional: dos procesos simultáneos no pueden enviar el mismo aviso dos veces.';

-- Cola de push: avisos recientes, sin enviar, de clientes que quieren avisos de pedidos y tienen al
-- menos un dispositivo vivo. La ventana corta evita que una caída de una hora despierte a todos con
-- avisos viejos: un pedido de ayer ya no es noticia.
create index customer_notifications_push_queue_idx
  on customer_notifications(created_at) where pushed_at is null;

-- ── 4. Misma política de seguridad que el resto del esquema (0009/0080) ─────
alter table push_subscriptions enable row level security;
create policy pdp_app_all on push_subscriptions for all to pdp_app using (true) with check (true);
alter table customer_notification_prefs enable row level security;
create policy pdp_app_all on customer_notification_prefs for all to pdp_app using (true) with check (true);

revoke all on push_subscriptions, customer_notification_prefs from public, anon, authenticated;
grant select, insert, update, delete on push_subscriptions, customer_notification_prefs to pdp_app;
revoke all on function customer_prefs(uuid) from public, anon, authenticated;
grant execute on function customer_prefs(uuid) to pdp_app;
