#!/usr/bin/env bash
# Simulacro de restauración: restaura el último respaldo en una base LOCAL temporal y verifica conteos.
# Un respaldo no es confiable hasta que se prueba. Uso: bash scripts/restore-drill.sh [archivo.dump]
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:-$(ls -t backups/*.dump 2>/dev/null | head -1)}"
[ -f "$FILE" ] || { echo "No hay respaldos en backups/. Corre: pnpm backup"; exit 2; }
DB="pdp_restore_drill_$(date +%s)"
START=$(date +%s)
createdb -h localhost "$DB"
pg_restore --no-owner --no-privileges -h localhost -d "$DB" "$FILE"
psql -h localhost -d "$DB" -tAc "select 'products='||count(*) from products union all select 'orders='||count(*) from orders union all select 'customers='||count(*) from customers union all select 'migrations='||count(*) from schema_migrations"
# La restauración debe permitir operar: probamos una función de negocio en modo lectura
psql -h localhost -d "$DB" -tAc "select count(*) from suggested_production(current_date)" >/dev/null
dropdb -h localhost "$DB"
END=$(date +%s)
echo "✔ Simulacro OK en $((END-START)) s (RTO medido). Archivo: $FILE"
echo "$(date -u +%FT%TZ) $FILE $((END-START))s OK" >> backups/restore-drills.log
