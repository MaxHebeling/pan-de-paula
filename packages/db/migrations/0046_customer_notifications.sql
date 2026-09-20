-- 0046_customer_notifications.sql — Avisos para el CLIENTE cuando su pedido cambia de estado.
-- Aditiva. Rango reservado 0040–0049 (clientes/fidelización).
--
-- De dónde salen: de `order_status_history`, que YA registra todos los cambios de estado del pedido
-- (lo escriben create_order, change_order_status, la anulación de ventas y el importador histórico).
-- Un cambio registrado = un aviso, y ni uno más: `status_history_id` es único, así que reintentar la
-- misma operación no puede duplicar el aviso. No hay una segunda lógica de estados en ningún lado.
--
-- Los textos viven AQUÍ, en `customer_notification_text`, y el aviso los guarda ya redactados: el
-- portal y (más adelante) el push muestran la misma frase, sin copiarla en el código de cada app.
--
-- Qué NO notifica:
--   · pedidos sin cliente identificado (mostrador anónimo): no hay a quién avisarle;
--   · estados internos del negocio (`new`, `paid`, `completed`): al cliente le importa su pedido,
--     no la contabilidad. `paid` se le informa junto con la confirmación;
--   · cambios con fecha vieja: el importador histórico escribe historial con la fecha de la venta
--     original, y nadie quiere recibir hoy el aviso de un pedido de hace un año.

-- ── 1. Avisos del cliente ───────────────────────────────────────────────────
create table customer_notifications (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid not null references customers(id) on delete cascade,
  order_id           uuid references orders(id) on delete cascade,
  -- Una fila de historial genera como mucho un aviso (idempotencia de verdad, no "casi").
  status_history_id  bigint unique references order_status_history(id) on delete cascade,
  kind               text not null,
  title              text not null,
  body               text,
  created_at         timestamptz not null default now(),
  read_at            timestamptz
);
create index customer_notifications_inbox_idx
  on customer_notifications(customer_id, created_at desc);
create index customer_notifications_unread_idx
  on customer_notifications(customer_id) where read_at is null;

comment on table customer_notifications is
  'Avisos que el cliente ve en su portal. Se generan solos desde order_status_history; status_history_id es único para que una misma transición no avise dos veces.';

-- ── 2. Los textos, en un solo lugar ─────────────────────────────────────────
-- Devuelve null cuando ese estado no se le anuncia al cliente.
create or replace function customer_notification_text(p_status order_status, p_folio text)
returns table (kind text, title text, body text)
language sql immutable as $$
  select * from (values
    ('confirmed',        'Tu pedido está confirmado 🥐', 'Ya lo tenemos apuntado. Te avisamos en cuanto entre al horno.'),
    ('in_production',    'Tu pedido está en preparación 🥐', 'Lo estamos horneando. Te avisamos cuando esté listo.'),
    ('ready',            '¡Tu pedido está listo! 🎉',    'Ya salió del horno.'),
    ('ready_for_pickup', '¡Tu pedido está listo! 🎉',    'Puedes pasar por él cuando gustes.'),
    ('out_for_delivery', 'Tu pedido va en camino 🚚',    'Sale para tu dirección.'),
    ('delivered',        'Pedido entregado ✅',          '¡Gracias por tu compra!'),
    ('cancelled',        'Tu pedido fue cancelado',      'Si no lo esperabas, escríbenos y lo revisamos.'),
    ('refunded',         'Tu pedido fue reembolsado',    'El reembolso ya está hecho de nuestro lado.')
  ) as t(kind, title, body)
  where t.kind = p_status::text
$$;

comment on function customer_notification_text(order_status, text) is
  'Texto único de cada aviso al cliente. Si un estado no está aquí, no se le anuncia.';

-- ── 3. El disparador ────────────────────────────────────────────────────────
create or replace function notify_customer_on_status_change() returns trigger
language plpgsql as $$
declare
  v_customer uuid;
  v_folio text;
  t record;
begin
  select o.customer_id, o.folio into v_customer, v_folio from orders o where o.id = new.order_id;
  if v_customer is null then return new; end if;
  -- Historial con fecha vieja = importación de pedidos antiguos: se guarda, pero no se anuncia.
  if new.created_at < now() - interval '10 minutes' then return new; end if;
  select * into t from customer_notification_text(new.to_status, v_folio);
  if t.kind is null then return new; end if;
  insert into customer_notifications(customer_id, order_id, status_history_id, kind, title, body)
  values (v_customer, new.order_id, new.id, t.kind, t.title, coalesce(t.body, '') || ' Pedido ' || v_folio)
  on conflict (status_history_id) do nothing;
  return new;
end $$;

create trigger trg_notify_customer_on_status
  after insert on order_status_history
  for each row execute function notify_customer_on_status_change();

-- ── 4. Misma política de seguridad que el resto del esquema (0009/0080) ─────
alter table customer_notifications enable row level security;
create policy pdp_app_all on customer_notifications for all to pdp_app using (true) with check (true);
revoke all on customer_notifications from public, anon, authenticated;
grant select, insert, update, delete on customer_notifications to pdp_app;
revoke all on function customer_notification_text(order_status, text) from public, anon, authenticated;
grant execute on function customer_notification_text(order_status, text) to pdp_app;
