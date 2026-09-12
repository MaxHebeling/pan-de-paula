-- 0009_security.sql — Rol de aplicación con mínimo privilegio, RLS habilitado en todo, nada expuesto a anon/authenticated.
-- La app se conecta como `pdp_app` (o como el owner en local). PostgREST (anon/authenticated) no puede leer nada.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pdp_app') then
    create role pdp_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- Cerrar acceso por defecto
revoke all on schema public from public;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

-- Acceso de la aplicación
grant usage on schema public to pdp_app;
grant select, insert, update, delete on all tables in schema public to pdp_app;
grant usage, select on all sequences in schema public to pdp_app;
grant execute on all functions in schema public to pdp_app;
alter default privileges in schema public grant select, insert, update, delete on tables to pdp_app;
alter default privileges in schema public grant usage, select on sequences to pdp_app;
alter default privileges in schema public grant execute on functions to pdp_app;

-- RLS en todas las tablas + política total para pdp_app (el owner la omite por definición)
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('drop policy if exists pdp_app_all on public.%I', t.tablename);
    execute format('create policy pdp_app_all on public.%I for all to pdp_app using (true) with check (true)', t.tablename);
  end loop;
end $$;

-- Las funciones de negocio corren con los privilegios del invocador (pdp_app), no son SECURITY DEFINER,
-- salvo audit_row_change que necesita escribir audit_logs desde cualquier contexto.
