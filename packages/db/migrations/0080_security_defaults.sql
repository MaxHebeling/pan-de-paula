-- 0080_security_defaults.sql — Endurecimiento: Supabase concede por defecto privilegios a anon/authenticated
-- sobre objetos nuevos del rol postgres (ALTER DEFAULT PRIVILEGES propios de la plataforma). 0009 revocó lo
-- existente en su momento, pero todo lo creado después (0010–0070) volvió a quedar expuesto vía PostgREST.
-- Esta migración: (1) revoca de nuevo TODO lo actual, (2) fija los privilegios por defecto del rol migrador
-- para que lo futuro nazca cerrado, (3) garantiza que pdp_app conserve acceso.

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Defaults del rol que ejecuta migraciones (postgres en Supabase, el owner local en desarrollo)
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to pdp_app;
alter default privileges in schema public grant usage, select on sequences to pdp_app;
alter default privileges in schema public grant execute on functions to pdp_app;

-- Si la plataforma definió defaults explícitos "for role postgres", ciérralos también (no falla si no existe el rol)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') and current_user <> 'postgres' then
    begin
      execute 'alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated';
      execute 'alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated';
      execute 'alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated';
    exception when insufficient_privilege then
      raise notice 'sin permiso para alterar defaults de postgres; se omite';
    end;
  end if;
end $$;

-- Re-garantiza acceso de la app a todo lo existente
grant select, insert, update, delete on all tables in schema public to pdp_app;
grant usage, select on all sequences in schema public to pdp_app;
grant execute on all functions in schema public to pdp_app;

-- RLS + política pdp_app en cualquier tabla nueva que no la tenga
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.tablename and policyname = 'pdp_app_all') then
      execute format('create policy pdp_app_all on public.%I for all to pdp_app using (true) with check (true)', t.tablename);
    end if;
  end loop;
end $$;

-- Verificación: ninguna función ni tabla de public accesible por anon/authenticated
do $$
declare n_fn int; n_tb int;
begin
  select count(*) into n_fn from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  select count(*) into n_tb from pg_tables t where schemaname = 'public'
     and (has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'select') or has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'select'));
  if n_fn > 0 or n_tb > 0 then
    raise exception 'Exposición residual: % funciones y % tablas accesibles por anon/authenticated', n_fn, n_tb;
  end if;
end $$;
