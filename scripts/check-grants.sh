#!/usr/bin/env bash
# Verifica que en la base indicada NINGUNA tabla ni función de negocio de `public` sea accesible por anon/authenticated
# (exposición vía PostgREST/Supabase). Uso: bash scripts/check-grants.sh "<postgres url>"   (respeta PGSSLROOTCERT)
set -euo pipefail
URL="${1:?url de base de datos}"
cd "$(dirname "$0")/.."
if [ -f certs/supabase-root-2021-ca.pem ] && [[ "$URL" == *supabase.com* ]]; then export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"; fi
OUT=$(psql "$URL" -tAc "
select coalesce(string_agg(x, E'\n'), '') from (
  select 'FN ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'TABLA ' || tablename from pg_tables where schemaname = 'public'
     and (has_table_privilege('anon', format('%I.%I', schemaname, tablename), 'select') or has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'select'))
  union all
  select 'SIN RLS ' || tablename from pg_tables t where schemaname = 'public'
     and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity)
) s")
if [ -n "$OUT" ]; then echo "✗ Exposición detectada:"; echo "$OUT"; exit 1; fi
echo "✓ Sin exposición: anon/authenticated no acceden a tablas ni funciones de public; RLS en todas las tablas"
