#!/usr/bin/env bash
# Simulacro de restauración: restaura el último respaldo en una base LOCAL temporal y verifica que quedó completa.
# Un respaldo no es confiable hasta que se prueba. Uso: bash scripts/restore-drill.sh [archivo.dump]
# Falla (exit 1) si pg_restore reporta errores reales o si faltan tablas respecto al contenido del dump.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-$(ls -t backups/*.dump 2>/dev/null | head -1)}"
[ -f "$FILE" ] || { echo "No hay respaldos en backups/. Corre: pnpm backup"; exit 2; }
DB="pdp_restore_drill_$(date +%s)"
ERR=$(mktemp)
cleanup() { dropdb -h localhost --if-exists "$DB" >/dev/null 2>&1 || true; rm -f "$ERR"; }
trap cleanup EXIT
START=$(date +%s)
createdb -h localhost "$DB"
# Las tablas usan citext/pgcrypto/pg_trgm. Los respaldos nuevos las incluyen (backup.sh --extension); para
# respaldos anteriores las creamos antes. `if not exists` hace ambas rutas compatibles.
# pgcrypto se crea en el MISMO esquema que en el origen (Supabase: extensions; local: public), porque los
# defaults de columnas lo referencian con esquema calificado (extensions.gen_random_bytes / public.gen_random_bytes).
PGC_SCHEMA=$(pg_restore -f - "$FILE" 2>/dev/null | grep -oE 'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA [a-z_]+' | awk '{print $NF}' | head -1)
PGC_SCHEMA="${PGC_SCHEMA:-public}"
psql -h localhost -d "$DB" -q -c "create schema if not exists $PGC_SCHEMA; create extension if not exists pgcrypto with schema $PGC_SCHEMA; create extension if not exists citext; create extension if not exists pg_trgm;"
psql -h localhost -d postgres -q -c "alter database \"$DB\" set search_path = public, $PGC_SCHEMA"
set +e
pg_restore --no-owner --no-privileges -h localhost -d "$DB" "$FILE" 2>"$ERR"
RC=$?
set -e
# Único error benigno: el dump trae `CREATE SCHEMA public` y la base nueva ya lo tiene.
REAL_ERRORS=$(grep -E '^pg_restore: error' "$ERR" | grep -vc 'schema "public" already exists' || true)
if [ "$REAL_ERRORS" -gt 0 ]; then
  echo "✗ pg_restore reportó $REAL_ERRORS error(es) reales (exit $RC). Primeros:"
  grep -E '^pg_restore: error' "$ERR" | grep -v 'schema "public" already exists' | head -5
  echo "$(date -u +%FT%TZ) $FILE FAIL restore-errors=$REAL_ERRORS" >> backups/restore-drills.log
  exit 1
fi
# Entradas "TABLE public <nombre>" del índice del dump (las "TABLE DATA" son los datos, no cuentan)
EXPECTED_TABLES=$(pg_restore --list "$FILE" | grep -cE '^[0-9]+; [0-9]+ [0-9]+ TABLE public ' || true)
ACTUAL_TABLES=$(psql -h localhost -d "$DB" -tAc "select count(*) from pg_tables where schemaname = 'public'")
if [ "$ACTUAL_TABLES" -ne "$EXPECTED_TABLES" ]; then
  echo "✗ Restauración incompleta: $ACTUAL_TABLES tablas restauradas de $EXPECTED_TABLES en el dump"
  echo "$(date -u +%FT%TZ) $FILE FAIL tables=$ACTUAL_TABLES/$EXPECTED_TABLES" >> backups/restore-drills.log
  exit 1
fi
psql -h localhost -d "$DB" -tAc "select 'products='||count(*) from products union all select 'orders='||count(*) from orders union all select 'customers='||count(*) from customers union all select 'migrations='||count(*) from schema_migrations"
REPO_MIGRATIONS=$(ls packages/db/migrations/[0-9][0-9][0-9][0-9]_*.sql | wc -l | tr -d ' ')
DUMP_MIGRATIONS=$(psql -h localhost -d "$DB" -tAc "select count(*) from schema_migrations")
[ "$DUMP_MIGRATIONS" -eq "$REPO_MIGRATIONS" ] || echo "  (aviso: el respaldo tiene $DUMP_MIGRATIONS migraciones y el repo $REPO_MIGRATIONS; tras restaurar corre pnpm db:migrate)"
# La restauración debe permitir operar: probamos una función de negocio en modo lectura
psql -h localhost -d "$DB" -tAc "select count(*) from suggested_production(current_date)" >/dev/null
END=$(date +%s)
echo "✔ Simulacro OK en $((END-START)) s (RTO medido). Tablas: $ACTUAL_TABLES. Archivo: $FILE"
echo "$(date -u +%FT%TZ) $FILE $((END-START))s OK tables=$ACTUAL_TABLES" >> backups/restore-drills.log
