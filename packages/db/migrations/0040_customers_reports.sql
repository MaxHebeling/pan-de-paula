-- 0040_customers_reports.sql — Clientes 360 (fusión, duplicados), eventos automáticos de cliente,
-- funciones de reporte (agregaciones en SQL, excluyen ventas anuladas y restan reembolsos), estado de entrega en Instagram.
-- Aditiva: no altera tablas existentes salvo columnas nuevas con default.

create extension if not exists pg_trgm;

-- ── Índices de soporte ──────────────────────────────────────────────────────
create index if not exists customers_name_trgm_idx on customers using gin (full_name gin_trgm_ops);
create index if not exists customers_created_idx on customers(created_at desc);
create index if not exists customer_events_kind_idx on customer_events(kind, created_at desc);
create index if not exists sales_channel_idx on sales(channel, sold_at desc);
create index if not exists refunds_created_idx on refunds(created_at desc) where status = 'completed';
create index if not exists payments_confirmed_idx on payments(confirmed_at desc) where confirmed_at is not null;
create index if not exists ig_conversations_status_idx on instagram_conversations(status, last_message_at desc nulls last);
create index if not exists leads_status_idx on leads(status, created_at desc);
create index if not exists orders_folio_trgm_idx on orders using gin (folio gin_trgm_ops);
create index if not exists products_name_trgm_idx on products using gin (name gin_trgm_ops);

-- ── Instagram: estado de entrega de mensajes salientes ──────────────────────
-- 'sent' = entregado a Meta · 'pending' = guardado sin enviar (integración no configurada) · 'failed' = Meta rechazó.
alter table instagram_messages add column if not exists delivery_status text not null default 'sent'
  check (delivery_status in ('sent','pending','failed'));
alter table instagram_messages add column if not exists delivery_error text;
create index if not exists instagram_messages_pending_idx on instagram_messages(created_at) where delivery_status = 'pending';

-- ── Posibles duplicados ─────────────────────────────────────────────────────
-- Teléfono (últimos 10 dígitos), email exacto o nombre similar (trigramas).
create or replace function customer_duplicates(p_customer_id uuid)
returns table (
  id uuid, public_code text, full_name text, phone text, email text,
  total_orders integer, points_balance integer, last_purchase_at timestamptz, reasons text[]
) language sql stable as $$
  with me as (
    select c.id, c.full_name, c.email,
           nullif(right(regexp_replace(coalesce(c.phone::text, ''), '\D', '', 'g'), 10), '') as phone10
    from customers c where c.id = p_customer_id
  ),
  cand as (
    select c.id, c.public_code, c.full_name, c.phone::text as phone, c.email::text as email,
           c.total_orders, c.points_balance, c.last_purchase_at,
           array_remove(array[
             case when me.phone10 is not null
                   and right(regexp_replace(coalesce(c.phone::text, ''), '\D', '', 'g'), 10) = me.phone10 then 'phone' end,
             case when me.email is not null and c.email = me.email then 'email' end,
             case when similarity(c.full_name, me.full_name) >= 0.45 then 'name' end
           ]::text[], null) as reasons
    from customers c cross join me
    where c.id <> me.id and c.deleted_at is null and c.merged_into_id is null
  )
  select id, public_code, full_name, phone, email, total_orders, points_balance, last_purchase_at, reasons
  from cand where cardinality(reasons) > 0
  order by cardinality(reasons) desc, total_orders desc
  limit 10
$$;

-- ── Fusionar clientes ───────────────────────────────────────────────────────
-- Mueve pedidos, ventas, canjes, cupones, eventos, leads, conversaciones y direcciones al cliente que se conserva;
-- transfiere el saldo de puntos por ledger (append-only: no se reescriben transacciones históricas);
-- suma estadísticas, completa datos faltantes, marca merged_into_id y recalcula nivel.
create or replace function merge_customers(p_keep_id uuid, p_merge_id uuid) returns jsonb
language plpgsql as $$
declare
  k customers%rowtype;
  m customers%rowtype;
  n_orders integer; n_sales integer; n_redemptions integer; n_coupons integer;
  n_events integer; n_leads integer; n_ig integer; n_addresses integer;
  v_points integer;
  v_lifetime integer;
begin
  if p_keep_id is null or p_merge_id is null then raise exception 'Faltan clientes a fusionar' using errcode = 'check_violation'; end if;
  if p_keep_id = p_merge_id then raise exception 'No se puede fusionar un cliente consigo mismo' using errcode = 'check_violation'; end if;
  -- Bloqueo en orden determinista (evita deadlocks entre fusiones concurrentes)
  perform 1 from customers where id in (p_keep_id, p_merge_id) order by id for update;
  select * into k from customers where id = p_keep_id;
  if k.id is null then raise exception 'El cliente destino no existe' using errcode = 'foreign_key_violation'; end if;
  if k.deleted_at is not null or k.merged_into_id is not null then
    raise exception 'El cliente destino ya fue eliminado o fusionado' using errcode = 'check_violation';
  end if;
  select * into m from customers where id = p_merge_id;
  if m.id is null then raise exception 'El cliente a fusionar no existe' using errcode = 'foreign_key_violation'; end if;
  if m.merged_into_id is not null then raise exception 'Ese cliente ya fue fusionado' using errcode = 'check_violation'; end if;

  update orders set customer_id = k.id where customer_id = m.id;
  get diagnostics n_orders = row_count;
  update sales set customer_id = k.id where customer_id = m.id;
  get diagnostics n_sales = row_count;
  update reward_redemptions set customer_id = k.id where customer_id = m.id;
  get diagnostics n_redemptions = row_count;
  update coupon_redemptions set customer_id = k.id where customer_id = m.id;
  get diagnostics n_coupons = row_count;
  update leads set customer_id = k.id where customer_id = m.id;
  get diagnostics n_leads = row_count;
  update instagram_conversations set customer_id = k.id where customer_id = m.id;
  get diagnostics n_ig = row_count;

  if exists (select 1 from customer_addresses where customer_id = k.id and is_default) then
    update customer_addresses set is_default = false where customer_id = m.id;
  end if;
  update customer_addresses set customer_id = k.id where customer_id = m.id;
  get diagnostics n_addresses = row_count;

  -- Eventos: se mueven los que no chocan con el índice diario; el resto se descarta
  update customer_events e set customer_id = k.id
   where e.customer_id = m.id
     and not exists (
       select 1 from customer_events x
        where x.customer_id = k.id and x.kind = e.kind
          and (x.created_at at time zone 'UTC')::date = (e.created_at at time zone 'UTC')::date);
  get diagnostics n_events = row_count;
  delete from customer_events where customer_id = m.id;

  -- Puntos: transferencia por ledger (el historial del fusionado permanece bajo su id)
  v_points := m.points_balance;
  v_lifetime := k.lifetime_points + m.lifetime_points;
  if v_points > 0 then
    perform loyalty_post(m.id, 'adjust', -v_points, null, null, 'Fusión hacia ' || k.public_code);
    perform loyalty_post(k.id, 'adjust', v_points, null, null, 'Fusión desde ' || m.public_code);
  end if;

  -- Primero se marca el fusionado (libera los índices únicos de teléfono/email)
  update customers set merged_into_id = k.id, marketing_consent = false where id = m.id;

  update customers set
    phone = coalesce(k.phone, m.phone),
    email = coalesce(k.email, m.email),
    birthday = coalesce(k.birthday, m.birthday),
    favorite_product_id = coalesce(k.favorite_product_id, m.favorite_product_id),
    tags = (select coalesce(array_agg(distinct t), '{}') from unnest(k.tags || m.tags) t),
    marketing_consent = k.marketing_consent or m.marketing_consent,
    marketing_opt_out_at = case when (k.marketing_consent or m.marketing_consent) then null else coalesce(k.marketing_opt_out_at, m.marketing_opt_out_at) end,
    notes = nullif(concat_ws(E'\n', k.notes,
              'Fusionado ' || m.public_code || ' (' || m.full_name
              || coalesce(', tel. ' || m.phone::text, '') || coalesce(', ' || m.email::text, '') || ') el ' || to_char(now(), 'YYYY-MM-DD'),
              m.notes), ''),
    total_orders = k.total_orders + m.total_orders,
    total_spent_cents = k.total_spent_cents + m.total_spent_cents,
    lifetime_points = v_lifetime,
    first_purchase_at = least(k.first_purchase_at, m.first_purchase_at),
    last_purchase_at = greatest(k.last_purchase_at, m.last_purchase_at)
  where id = k.id;

  perform recompute_customer_tier(k.id);
  insert into customer_events(customer_id, kind, payload)
  values (k.id, 'merged', jsonb_build_object('from', m.public_code, 'from_id', m.id, 'orders', n_orders, 'points', v_points))
  on conflict do nothing;
  perform emit_event('CUSTOMER_MERGED', 'customer', k.id::text,
    jsonb_build_object('merged_id', m.id, 'merged_code', m.public_code, 'orders', n_orders, 'sales', n_sales, 'points', v_points));

  return jsonb_build_object('keep_id', k.id, 'merged_id', m.id, 'orders', n_orders, 'sales', n_sales,
    'redemptions', n_redemptions, 'coupon_redemptions', n_coupons, 'events', n_events, 'leads', n_leads,
    'conversations', n_ig, 'addresses', n_addresses, 'points_transferred', v_points);
end $$;

-- ── Eventos automáticos de cliente (cron diario, idempotente) ───────────────
-- Cumpleaños del día, inactividad 30/60 días (una vez por periodo de inactividad), aniversario de alta.
create or replace function run_customer_events(p_today date default null) returns jsonb
language plpgsql as $$
declare
  tz text;
  today date;
  n_birthday integer := 0;
  n_in30 integer := 0;
  n_in60 integer := 0;
  n_anniv integer := 0;
begin
  select timezone into tz from business_settings where id = 1;
  today := coalesce(p_today, (now() at time zone tz)::date);

  with ins as (
    insert into customer_events(customer_id, kind, payload)
    select c.id, 'birthday', jsonb_build_object('date', today, 'age', extract(year from age(today, c.birthday))::int)
    from customers c
    where c.deleted_at is null and c.merged_into_id is null and c.birthday is not null
      and to_char(c.birthday, 'MM-DD') = to_char(today, 'MM-DD')
    on conflict do nothing
    returning customer_id
  ), notif as (
    insert into notifications(kind, severity, title, body, entity, entity_id)
    select 'birthday', 'info', 'Cumpleaños de cliente', c.full_name || ' cumple años hoy · ' || c.public_code, 'customer', c.id::text
    from ins join customers c on c.id = ins.customer_id
    returning 1
  ) select count(*) into n_birthday from notif;

  with ins as (
    insert into customer_events(customer_id, kind, payload)
    select c.id, 'inactive_30', jsonb_build_object('days', today - (c.last_purchase_at at time zone tz)::date, 'last_purchase_at', c.last_purchase_at)
    from customers c
    where c.deleted_at is null and c.merged_into_id is null and c.last_purchase_at is not null
      and (c.last_purchase_at at time zone tz)::date <= today - 30
      and (c.last_purchase_at at time zone tz)::date > today - 60
      and not exists (select 1 from customer_events e where e.customer_id = c.id and e.kind = 'inactive_30' and e.created_at >= c.last_purchase_at)
    on conflict do nothing
    returning customer_id
  ) select count(*) into n_in30 from ins;
  if n_in30 > 0 then
    insert into notifications(kind, severity, title, body, entity)
    values ('inactive_customers', 'warning', 'Clientes sin comprar 30 días', n_in30 || ' cliente(s) cumplieron 30 días sin comprar. Revisa Clientes → Inactivos.', 'customer');
  end if;

  with ins as (
    insert into customer_events(customer_id, kind, payload)
    select c.id, 'inactive_60', jsonb_build_object('days', today - (c.last_purchase_at at time zone tz)::date, 'last_purchase_at', c.last_purchase_at)
    from customers c
    where c.deleted_at is null and c.merged_into_id is null and c.last_purchase_at is not null
      and (c.last_purchase_at at time zone tz)::date <= today - 60
      and not exists (select 1 from customer_events e where e.customer_id = c.id and e.kind = 'inactive_60' and e.created_at >= c.last_purchase_at)
    on conflict do nothing
    returning customer_id
  ) select count(*) into n_in60 from ins;
  if n_in60 > 0 then
    insert into notifications(kind, severity, title, body, entity)
    values ('inactive_customers', 'warning', 'Clientes sin comprar 60 días', n_in60 || ' cliente(s) cumplieron 60 días sin comprar.', 'customer');
  end if;

  with ins as (
    insert into customer_events(customer_id, kind, payload)
    select c.id, 'anniversary', jsonb_build_object('years', extract(year from age(today, (c.created_at at time zone tz)::date))::int)
    from customers c
    where c.deleted_at is null and c.merged_into_id is null
      and to_char(c.created_at at time zone tz, 'MM-DD') = to_char(today, 'MM-DD')
      and (c.created_at at time zone tz)::date <= today - 365
    on conflict do nothing
    returning customer_id
  ), notif as (
    insert into notifications(kind, severity, title, body, entity, entity_id)
    select 'anniversary', 'info', 'Aniversario de cliente', c.full_name || ' cumple ' || extract(year from age(today, (c.created_at at time zone tz)::date))::int || ' año(s) con nosotros', 'customer', c.id::text
    from ins join customers c on c.id = ins.customer_id
    returning 1
  ) select count(*) into n_anniv from notif;

  return jsonb_build_object('date', today, 'birthday', n_birthday, 'inactive_30', n_in30, 'inactive_60', n_in60, 'anniversary', n_anniv);
end $$;

-- ── Reportes ────────────────────────────────────────────────────────────────
-- Rango en fechas locales del negocio (p_from y p_to inclusivos). Ventas anuladas excluidas; reembolsos completados restados.
create or replace function report_range(p_from date, p_to date, out v_from timestamptz, out v_to timestamptz)
language sql stable as $$
  select (p_from::timestamp at time zone bs.timezone), ((p_to + 1)::timestamp at time zone bs.timezone)
  from business_settings bs where bs.id = 1
$$;

create or replace function report_summary(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  rng record;
  v_from timestamptz; v_to timestamptz;
  v_sales jsonb; v_refunds bigint; v_customers_new integer; v_orders jsonb; v_waste jsonb; v_prod jsonb;
  v_payments jsonb; v_channels jsonb; v_inventory numeric; v_sessions jsonb;
begin
  select * into rng from report_range(p_from, p_to);
  v_from := rng.v_from; v_to := rng.v_to;

  select jsonb_build_object(
    'count', count(*),
    'gross_cents', coalesce(sum(total_cents), 0),
    'subtotal_cents', coalesce(sum(subtotal_cents), 0),
    'discount_cents', coalesce(sum(discount_cents), 0),
    'tip_cents', coalesce(sum(tip_cents), 0),
    'units', coalesce(sum(items_count), 0),
    'cost_cents', coalesce(sum(cost_cents), 0),
    'cost_missing', count(*) filter (where cost_cents is null),
    'ticket_cents', coalesce(round(avg(total_cents)), 0)::bigint,
    'customers_buying', count(distinct customer_id),
    'identified', count(*) filter (where customer_id is not null))
  into v_sales from sales s where s.voided_at is null and s.sold_at >= v_from and s.sold_at < v_to;

  select coalesce(sum(amount_cents), 0) into v_refunds
  from refunds where status = 'completed' and created_at >= v_from and created_at < v_to;

  select count(*) into v_customers_new
  from customers where deleted_at is null and merged_into_id is null and created_at >= v_from and created_at < v_to;

  select jsonb_build_object(
    'count', count(*),
    'web', count(*) filter (where channel = 'web'),
    'pos', count(*) filter (where channel = 'pos'),
    'other', count(*) filter (where channel not in ('web','pos')),
    'cancelled', count(*) filter (where status = 'cancelled'),
    'open', count(*) filter (where status in ('new','confirmed','payment_pending','paid','in_production','ready','ready_for_pickup','out_for_delivery')))
  into v_orders from orders where placed_at >= v_from and placed_at < v_to;

  select jsonb_build_object('count', count(*), 'qty', coalesce(sum(qty), 0), 'cost_cents', coalesce(sum(round(coalesce(cost_cents_snapshot, 0) * qty)), 0))
  into v_waste from waste_records where occurred_at >= v_from and occurred_at < v_to;

  select jsonb_build_object('batches', count(*), 'qty', coalesce(sum(qty), 0), 'cost_cents', coalesce(sum(round(coalesce(cost_cents_snapshot, 0) * qty)), 0))
  into v_prod from production_batches where produced_at >= v_from and produced_at < v_to;

  select coalesce(jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount_cents', amount, 'refunded_cents', refunded) order by amount desc), '[]'::jsonb)
  into v_payments from (
    select p.method::text as method, count(*) as n, sum(p.amount_cents) as amount, coalesce(sum(rf.refunded), 0) as refunded
    from payments p
    join sales s on s.order_id = p.order_id
    left join lateral (select sum(r.amount_cents) as refunded from refunds r where r.payment_id = p.id and r.status = 'completed') rf on true
    where s.voided_at is null and p.status in ('paid','partially_refunded','refunded')
      and p.confirmed_at >= v_from and p.confirmed_at < v_to
    group by p.method) x;

  select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'count', n, 'revenue_cents', revenue, 'units', units) order by revenue desc), '[]'::jsonb)
  into v_channels from (
    select channel::text, count(*) as n, sum(total_cents) as revenue, sum(items_count) as units
    from sales where voided_at is null and sold_at >= v_from and sold_at < v_to group by channel) x;

  select coalesce(sum(m.qty), 0) into v_inventory
  from inventory_movements m join products p on p.id = m.product_id
  where p.deleted_at is null and p.track_stock and m.occurred_at < v_to;

  select jsonb_build_object('count', count(*), 'difference_cents', coalesce(sum(difference_cents), 0), 'with_difference', count(*) filter (where coalesce(difference_cents, 0) <> 0))
  into v_sessions from register_sessions where opened_at >= v_from and opened_at < v_to;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'sales', v_sales,
    'refunds_cents', v_refunds,
    'net_cents', (v_sales->>'gross_cents')::bigint - v_refunds,
    'customers_new', v_customers_new,
    'orders', v_orders,
    'waste', v_waste,
    'production', v_prod,
    'payments', v_payments,
    'channels', v_channels,
    'inventory_units', v_inventory,
    'register', v_sessions);
end $$;

-- Serie diaria (para tablas y barras CSS)
create or replace function report_daily_series(p_from date, p_to date) returns table (
  day date, sales_count integer, revenue_cents bigint, refunds_cents bigint, units numeric,
  waste_qty numeric, production_qty numeric, new_customers integer, cost_cents bigint
) language sql stable as $$
  with bs as (select timezone as tz from business_settings where id = 1),
  days as (select generate_series(p_from, p_to, interval '1 day')::date as day)
  select d.day,
    coalesce((select count(*) from sales s, bs where s.voided_at is null and (s.sold_at at time zone bs.tz)::date = d.day), 0)::int,
    coalesce((select sum(total_cents) from sales s, bs where s.voided_at is null and (s.sold_at at time zone bs.tz)::date = d.day), 0)::bigint,
    coalesce((select sum(amount_cents) from refunds r, bs where r.status = 'completed' and (r.created_at at time zone bs.tz)::date = d.day), 0)::bigint,
    coalesce((select sum(items_count) from sales s, bs where s.voided_at is null and (s.sold_at at time zone bs.tz)::date = d.day), 0),
    coalesce((select sum(qty) from waste_records w, bs where (w.occurred_at at time zone bs.tz)::date = d.day), 0),
    coalesce((select sum(qty) from production_batches b, bs where (b.produced_at at time zone bs.tz)::date = d.day), 0),
    coalesce((select count(*) from customers c, bs where c.deleted_at is null and c.merged_into_id is null and (c.created_at at time zone bs.tz)::date = d.day), 0)::int,
    coalesce((select sum(cost_cents) from sales s, bs where s.voided_at is null and (s.sold_at at time zone bs.tz)::date = d.day), 0)::bigint
  from days d order by d.day
$$;

-- Rentabilidad por producto. Ingresos netos de descuentos de pedido (prorrateados), costo snapshot de la venta.
create or replace function report_products(p_from date, p_to date) returns table (
  product_id uuid, product_name text, category_name text, produced numeric, sold numeric, waste numeric, on_hand numeric,
  revenue_cents bigint, cost_cents bigint, profit_cents bigint, margin_bps integer, cost_missing boolean
) language sql stable as $$
  with rr as (select * from report_range(p_from, p_to))
  select p.id, p.name, c.name,
    coalesce(prod.qty, 0), coalesce(sold.qty, 0), coalesce(w.qty, 0), coalesce(l.on_hand, 0),
    coalesce(sold.revenue, 0)::bigint,
    sold.cost::bigint,
    case when sold.cost is not null then (coalesce(sold.revenue, 0) - sold.cost)::bigint end,
    case when sold.cost is not null and coalesce(sold.revenue, 0) > 0
         then round((coalesce(sold.revenue, 0) - sold.cost)::numeric / sold.revenue * 10000)::integer end,
    coalesce(sold.missing, false)
  from products p
  left join categories c on c.id = p.category_id
  left join lateral (
    select sum(b.qty) as qty from production_batches b, rr
    where b.product_id = p.id and b.produced_at >= rr.v_from and b.produced_at < rr.v_to) prod on true
  left join lateral (
    select sum(oi.qty) as qty,
           sum(oi.total_cents - coalesce(round(o.discount_cents::numeric * oi.total_cents / nullif(o.subtotal_cents, 0)), 0)) as revenue,
           case when bool_and(oi.unit_cost_cents is not null) then sum(round(oi.unit_cost_cents * oi.qty)) end as cost,
           bool_or(oi.unit_cost_cents is null) as missing
    from order_items oi
    join sales s on s.order_id = oi.order_id
    join orders o on o.id = oi.order_id, rr
    where oi.product_id = p.id and s.voided_at is null and s.sold_at >= rr.v_from and s.sold_at < rr.v_to) sold on true
  left join lateral (
    select sum(w.qty) as qty from waste_records w, rr
    where w.product_id = p.id and w.occurred_at >= rr.v_from and w.occurred_at < rr.v_to) w on true
  left join inventory_levels l on l.product_id = p.id
  where p.deleted_at is null
    and (coalesce(prod.qty, 0) > 0 or coalesce(sold.qty, 0) > 0 or coalesce(w.qty, 0) > 0 or (p.is_active and p.track_stock))
  order by coalesce(sold.revenue, 0) desc, p.name
$$;

-- Clientes: nuevos, recurrentes, top, por nivel, inactivos, puntos.
create or replace function report_customers(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  rng record; v_from timestamptz; v_to timestamptz;
  v_new integer; v_buying integer; v_recurring integer; v_returning integer;
  v_top jsonb; v_tiers jsonb; v_inactive30 integer; v_inactive60 integer; v_points jsonb; v_sources jsonb;
begin
  select * into rng from report_range(p_from, p_to);
  v_from := rng.v_from; v_to := rng.v_to;

  select count(*) into v_new from customers where deleted_at is null and merged_into_id is null and created_at >= v_from and created_at < v_to;

  select count(*), count(*) filter (where n >= 2), count(*) filter (where had_before)
    into v_buying, v_recurring, v_returning
  from (
    select s.customer_id, count(*) as n,
           exists (select 1 from sales x where x.customer_id = s.customer_id and x.voided_at is null and x.sold_at < v_from) as had_before
    from sales s where s.voided_at is null and s.customer_id is not null and s.sold_at >= v_from and s.sold_at < v_to
    group by s.customer_id) x;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'public_code', public_code, 'full_name', full_name, 'tier_key', tier_key,
                                               'sales', n, 'spent_cents', spent, 'last_purchase_at', last) order by spent desc), '[]'::jsonb)
  into v_top from (
    select c.id, c.public_code, c.full_name, c.tier_key, count(*) as n, sum(s.total_cents) as spent, max(s.sold_at) as last
    from sales s join customers c on c.id = s.customer_id
    where s.voided_at is null and s.sold_at >= v_from and s.sold_at < v_to
    group by c.id order by spent desc limit 15) t;

  select coalesce(jsonb_agg(jsonb_build_object('tier_key', key, 'name', name, 'rank', rank, 'customers', n, 'sales', ns, 'spent_cents', spent) order by rank), '[]'::jsonb)
  into v_tiers from (
    select t.key, t.name, t.rank,
           (select count(*) from customers c where c.deleted_at is null and c.merged_into_id is null and c.tier_key = t.key) as n,
           (select count(*) from sales s join customers c on c.id = s.customer_id where c.tier_key = t.key and s.voided_at is null and s.sold_at >= v_from and s.sold_at < v_to) as ns,
           (select coalesce(sum(s.total_cents), 0) from sales s join customers c on c.id = s.customer_id where c.tier_key = t.key and s.voided_at is null and s.sold_at >= v_from and s.sold_at < v_to) as spent
    from loyalty_tiers t) x;

  select count(*) filter (where last_purchase_at < v_to - interval '30 days'),
         count(*) filter (where last_purchase_at < v_to - interval '60 days')
    into v_inactive30, v_inactive60
  from customers where deleted_at is null and merged_into_id is null and last_purchase_at is not null;

  select jsonb_build_object(
    'issued', coalesce(sum(points) filter (where kind in ('earn','bonus')), 0),
    'redeemed', coalesce(-sum(points) filter (where kind = 'redeem'), 0),
    'adjusted', coalesce(sum(points) filter (where kind = 'adjust'), 0),
    'reversed', coalesce(-sum(points) filter (where kind = 'reversal'), 0))
  into v_points from loyalty_transactions where created_at >= v_from and created_at < v_to;

  select coalesce(jsonb_agg(jsonb_build_object('source', source, 'count', n) order by n desc), '[]'::jsonb)
  into v_sources from (select source, count(*) as n from customers where deleted_at is null and merged_into_id is null and created_at >= v_from and created_at < v_to group by source) x;

  return jsonb_build_object('from', p_from, 'to', p_to, 'new', v_new, 'buying', v_buying, 'recurring', v_recurring, 'returning', v_returning,
    'top', v_top, 'tiers', v_tiers, 'inactive_30', v_inactive30, 'inactive_60', v_inactive60, 'points', v_points, 'sources', v_sources,
    'total_active', (select count(*) from customers where deleted_at is null and merged_into_id is null),
    'marketing_consent', (select count(*) from customers where deleted_at is null and merged_into_id is null and marketing_consent));
end $$;

-- Mermas por motivo
create or replace function report_waste(p_from date, p_to date) returns table (
  reason text, count integer, qty numeric, cost_cents bigint
) language sql stable as $$
  with rr as (select * from report_range(p_from, p_to))
  select w.reason, count(*)::int, sum(w.qty), sum(round(coalesce(w.cost_cents_snapshot, 0) * w.qty))::bigint
  from waste_records w, rr where w.occurred_at >= rr.v_from and w.occurred_at < rr.v_to
  group by w.reason order by 4 desc, 3 desc
$$;
