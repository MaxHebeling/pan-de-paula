-- _post_migrate.sql — se ejecuta SIEMPRE al final de `pnpm db:migrate` (no es una migración versionada).
-- Cierra la superficie pública de forma determinista aunque una migración nueva olvide hacerlo o la plataforma
-- (Supabase) conceda privilegios por defecto a anon/authenticated.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to pdp_app;
grant select, insert, update, delete on all tables in schema public to pdp_app;
grant usage, select on all sequences in schema public to pdp_app;
grant execute on all functions in schema public to pdp_app;
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
