#!/usr/bin/env bash
# Verifica que en la base indicada NINGÚN objeto de `public` sea accesible por anon/authenticated
# (exposición vía PostgREST/Supabase). Uso: bash scripts/check-grants.sh "<postgres url>"   (respeta PGSSLROOTCERT)
# Falla (exit 1) con: funciones de negocio ejecutables, tablas / vistas / vistas materializadas legibles o
#   escribibles, secuencias usables, tablas sin RLS.
#   Las vistas importan especialmente: corren con los privilegios de su dueño y NO aplican RLS.
# Avisa (sin fallar) con: funciones de extensiones (pg_trgm, citext…) ejecutables y USAGE del esquema para anon;
#   en Supabase pueden pertenecer a supabase_admin y el rol migrador no siempre puede revocarlas.
set -euo pipefail
URL="${1:?url de base de datos}"
cd "$(dirname "$0")/.."
if [ -f certs/supabase-root-2021-ca.pem ] && [[ "$URL" == *supabase.com* ]]; then export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"; fi
ROLES="(values ('anon'),('authenticated')) r(rol) where exists (select 1 from pg_roles where rolname = r.rol)"
OUT=$(psql "$URL" -v ON_ERROR_STOP=1 -tAc "
select coalesce(string_agg(x, E'\n' order by x), '') from (
  select distinct 'FN ' || p.proname || ' → ' || r.rol as x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join $ROLES
   and n.nspname = 'public' and has_function_privilege(r.rol, p.oid, 'execute')
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select distinct case c.relkind when 'v' then 'VISTA ' when 'm' then 'VISTA MAT ' else 'TABLA ' end || c.relname || ' → ' || r.rol
  from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join $ROLES
   and n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
   and (has_table_privilege(r.rol, c.oid, 'select') or has_table_privilege(r.rol, c.oid, 'insert')
        or has_table_privilege(r.rol, c.oid, 'update') or has_table_privilege(r.rol, c.oid, 'delete'))
  union all
  select distinct 'SECUENCIA ' || c.relname || ' → ' || r.rol
  from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join $ROLES
   and n.nspname = 'public' and c.relkind = 'S'
   and (has_sequence_privilege(r.rol, c.oid, 'usage') or has_sequence_privilege(r.rol, c.oid, 'select') or has_sequence_privilege(r.rol, c.oid, 'update'))
  union all
  select 'SIN RLS ' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
) s")
WARN=$(psql "$URL" -v ON_ERROR_STOP=1 -tAc "
select coalesce(string_agg(x, E'\n' order by x), '') from (
  select 'funciones de extensiones ejecutables por ' || r.rol || ': ' || count(*) as x
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join $ROLES
   and n.nspname = 'public' and has_function_privilege(r.rol, p.oid, 'execute')
   and exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  group by r.rol
  union all
  select 'USAGE del esquema public para ' || r.rol from $ROLES and has_schema_privilege(r.rol, 'public', 'usage')
) s")
if [ -n "$WARN" ]; then echo "⚠ Aviso (no bloquea):"; echo "$WARN" | sed 's/^/  /'; fi
if [ -n "$OUT" ]; then echo "✗ Exposición detectada:"; echo "$OUT" | sed 's/^/  /'; exit 1; fi
echo "✓ Sin exposición: anon/authenticated no acceden a tablas, vistas, secuencias ni funciones de public; RLS en todas las tablas"
