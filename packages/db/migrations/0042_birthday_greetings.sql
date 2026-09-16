-- 0042_birthday_greetings.sql — Saludos de cumpleaños: regla del 29 de febrero + registro de saludos.
-- Rango reservado 0040–0049 (clientes/fidelización). Aditiva y compatible hacia atrás:
-- redefine run_customer_events conservando TODO su comportamiento anterior (0040 + 0041) y agrega
-- la observancia del 29 de febrero. No altera tablas existentes.
--
-- ── REGLA DEL 29 DE FEBRERO (documentada también en docs/ADMIN_MANUAL.md) ───────────────────────
-- Un cliente nacido el 29 de febrero solo tiene fecha exacta en los años bisiestos. Con la regla
-- anterior (to_char(birthday,'MM-DD') = to_char(today,'MM-DD')) esos clientes NO recibían nada
-- tres de cada cuatro años. Se adopta la convención más usada en México y Latinoamérica:
--
--   * Año bisiesto      → se celebra el 29 de febrero (fecha exacta).
--   * Año NO bisiesto   → se celebra el 28 de febrero (último día de febrero).
--
-- La edad en el año no bisiesto se calcula como diferencia de años (año actual − año de nacimiento),
-- NO con age(): age('2027-02-28','2000-02-29') devolvería 26 porque aún falta un día para el
-- aniversario exacto, y el 28 de febrero estamos celebrando justamente ese cumpleaños (27).
-- Ambas reglas viven en funciones SQL inmutables para que el cron, el CRM y las pruebas compartan
-- una sola fuente de verdad.

-- Fecha en la que se celebra el cumpleaños dentro del año p_year (única definición de la regla).
-- 29 de febrero en año NO bisiesto → 28 de febrero. El último día de febrero de p_year es 28 cuando
-- el año no es bisiesto y 29 cuando sí lo es.
create or replace function observed_birthday(p_birthday date, p_year integer) returns date
language sql immutable as $$
  select case
    when p_birthday is null or p_year is null then null
    when to_char(p_birthday, 'MM-DD') = '02-29'
      then (make_date(p_year, 3, 1) - 1)                      -- 29 de feb en bisiesto, 28 si no lo es
    else make_date(p_year, extract(month from p_birthday)::int, extract(day from p_birthday)::int)
  end
$$;

-- ¿El cliente nacido en p_birthday celebra su cumpleaños en la fecha local p_on?
create or replace function celebrates_birthday_on(p_birthday date, p_on date) returns boolean
language sql immutable as $$
  select coalesce(observed_birthday(p_birthday, extract(year from p_on)::int) = p_on, false)
$$;

-- Edad que cumple en la fecha observada (ver nota de la regla arriba).
create or replace function birthday_age_on(p_birthday date, p_on date) returns integer
language sql immutable as $$
  select case
    when p_birthday is null or p_on is null then null
    when to_char(p_birthday, 'MM-DD') = '02-29' and to_char(p_on, 'MM-DD') = '02-28'
      then (extract(year from p_on) - extract(year from p_birthday))::int
    else extract(year from age(p_on, p_birthday))::int
  end
$$;

-- ── Registro de saludos ─────────────────────────────────────────────────────────────────────────
-- Un saludo por cliente y año (clave primaria compuesta): la idempotencia es de la base, no del código.
-- El mensaje se genera en @pdp/domain (función pura con pruebas) y se guarda tal cual se previsualizó.
create table birthday_greetings (
  customer_id   uuid not null references customers(id) on delete cascade,
  year          integer not null check (year between 2000 and 2999),
  birthday_date date not null,                          -- fecha LOCAL observada (aplica la regla del 29 feb)
  tier_key      text references loyalty_tiers(key) on delete set null,  -- nivel al momento de generar
  message       text not null,
  generated_at  timestamptz not null default now(),
  generated_by  uuid references staff_users(id) on delete set null,
  sent_at       timestamptz,
  sent_by       uuid references staff_users(id) on delete set null,
  channel       text check (channel in ('whatsapp', 'email', 'manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (customer_id, year),
  -- Un saludo marcado como enviado siempre tiene canal, y viceversa.
  constraint birthday_greetings_sent_channel_chk check ((sent_at is null) = (channel is null))
);
create index birthday_greetings_year_idx on birthday_greetings(year, birthday_date);
create index birthday_greetings_pending_idx on birthday_greetings(birthday_date desc) where sent_at is null;
create trigger trg_birthday_greetings_updated before update on birthday_greetings
  for each row execute function set_updated_at();

-- Misma política de seguridad que el resto del esquema (0009): RLS + acceso total solo para pdp_app.
alter table birthday_greetings enable row level security;
create policy pdp_app_all on birthday_greetings for all to pdp_app using (true) with check (true);
revoke all on table birthday_greetings from public, anon, authenticated;
grant select, insert, update, delete on table birthday_greetings to pdp_app;

-- Las funciones nuevas heredan EXECUTE a PUBLIC aunque 0009 ajustó los default privileges: se cierra explícitamente.
revoke execute on function observed_birthday(date, integer) from public, anon, authenticated;
revoke execute on function celebrates_birthday_on(date, date) from public, anon, authenticated;
revoke execute on function birthday_age_on(date, date) from public, anon, authenticated;
grant execute on function observed_birthday(date, integer) to pdp_app;
grant execute on function celebrates_birthday_on(date, date) to pdp_app;
grant execute on function birthday_age_on(date, date) to pdp_app;

-- ── run_customer_events: mismo comportamiento de 0041 + regla del 29 de febrero ──────────────────
-- Cambios respecto de 0041 (y SOLO estos):
--   1. La detección de cumpleaños usa celebrates_birthday_on() en vez de comparar 'MM-DD' a pelo.
--   2. La edad usa birthday_age_on().
--   3. El payload agrega 'observed_rule' = 'feb29_on_feb28' cuando se aplicó la observancia.
-- Inactividad 30/60 y aniversario de alta quedan idénticos (incluidas las guardas por día local de 0041).
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
    select c.id, 'birthday',
           jsonb_build_object('date', today, 'age', birthday_age_on(c.birthday, today))
           || case when to_char(c.birthday, 'MM-DD') = '02-29' and to_char(today, 'MM-DD') = '02-28'
                   then jsonb_build_object('observed_rule', 'feb29_on_feb28') else '{}'::jsonb end
    from customers c
    where c.deleted_at is null and c.merged_into_id is null and c.birthday is not null
      and celebrates_birthday_on(c.birthday, today)
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
