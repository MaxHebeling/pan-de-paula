#!/usr/bin/env bash
# Aplica un archivo de datos de negocio (packages/db/import/negocio/*.sql) mostrando el antes y el después.
# Uso: bash scripts/datos-negocio.sh [local|staging|production] <archivo.sql> [--apply]
# Sin --apply simula: corre el archivo dentro de una transacción y la revierte.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:?entorno: local | staging | production}"
FILE="${2:?archivo .sql}"
MODE="${3:---dry-run}"
[ -f "$FILE" ] || { echo "No existe $FILE"; exit 2; }
if [ "$ENV" = "local" ]; then ENV_FILE=.env; else ENV_FILE=".env.$ENV"; fi
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?Falta DATABASE_URL}"
if [ "${DATABASE_SSL:-disable}" = "require" ]; then
  export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"
fi
estado() {
  psql "$DATABASE_URL" -X -q -c "select weekday, is_open, opens_at, closes_at from business_hours order by weekday" \
    -c "select name, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, is_active from ordering_windows order by sort_order"
}
echo "▶ Antes ($ENV)"; estado
if [ "$MODE" = "--apply" ]; then
  [ "$ENV" != "local" ] && bash scripts/backup.sh "$ENV" datos-negocio
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$FILE"
  echo "▶ Después ($ENV)"; estado
  echo "✔ Aplicado: $FILE"
else
  # Simulación: mismo SQL, pero la transacción se revierte al final.
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
begin;
$(sed -e '/^\\set/d' -e '/^begin;$/d' -e '/^commit;$/d' "$FILE")
select weekday, is_open, opens_at, closes_at from business_hours order by weekday;
select name, order_weekdays, cutoff_time, fulfillment_weekday, fulfillment_from, fulfillment_to, is_active from ordering_windows order by sort_order;
rollback;
SQL
  echo "· Simulación (no se escribió nada). Para aplicar: repite con --apply"
fi
