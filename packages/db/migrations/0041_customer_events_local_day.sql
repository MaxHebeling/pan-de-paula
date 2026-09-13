-- 0041_customer_events_local_day.sql — Auditoría 360° (catálogo P3-10).
-- El índice único customer_events_daily_idx usa la fecha UTC: dos corridas del cron el mismo día LOCAL
-- (p. ej. 16:00 y 17:30 en Tijuana) caían en días UTC distintos y duplicaban cumpleaños/aniversarios.
-- Se redefine run_customer_events con guardas por fecha local del negocio. Aditiva e idempotente.
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
      and not exists (select 1 from customer_events e where e.customer_id = c.id and e.kind = 'birthday'
                        and (e.created_at at time zone tz)::date = today)
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
      and not exists (select 1 from customer_events e where e.customer_id = c.id and e.kind = 'anniversary'
                        and (e.created_at at time zone tz)::date = today)
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
