#!/usr/bin/env bash
# Carga el catálogo real (hoja del dueño, 2026-09-15) en tres pasos trazables:
#   1. SQL: retira los productos demo del seed (inactivos, sin borrar) y prepara las categorías reales.
#   2. Importador · products: crea los productos de la hoja con su precio (import_batches/import_rows).
#   3. Importador · prices: actualiza el precio de los que ya existían (Croissant Dubai), con historial.
#
# Uso: bash scripts/catalogo-real.sh [local|staging|production]            → simulación (no escribe negocio)
#      bash scripts/catalogo-real.sh [local|staging|production] --apply    → aplica (production: respaldo antes)
# Idempotente: repetirlo no duplica productos ni vuelve a retirar nada.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-local}"
MODE="${2:---dry-run}"
case "$MODE" in --dry-run | --apply) ;; *) echo "Modo inválido: $MODE"; exit 2 ;; esac

if [ "$ENV" = "local" ]; then ENV_FILE=.env; else ENV_FILE=".env.$ENV"; fi
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?Falta DATABASE_URL}"
if [ "${DATABASE_SSL:-disable}" = "require" ]; then
  export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"
fi

DIR=packages/db/import/catalogo
STAFF="${IMPORT_STAFF_EMAIL:-}"
IMPORT_FLAGS=("$MODE")
[ -n "$STAFF" ] && IMPORT_FLAGS+=(--staff-email "$STAFF")
[ "$MODE" = "--apply" ] && [ "${APP_ENV:-}" = "production" ] && IMPORT_FLAGS+=(--yes-production)

echo "▶ Catálogo real → $ENV ($MODE)"
psql "$DATABASE_URL" -X -q -tAc "select 'Antes: ' || count(*) filter (where is_active and show_on_web) || ' productos visibles en web de ' || count(*) from products where deleted_at is null"

if [ "$MODE" = "--apply" ]; then
  if [ "$ENV" != "local" ]; then bash scripts/backup.sh "$ENV" catalogo-real; fi
  echo "▶ 1/3 Retirar demo y preparar categorías"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -1 -f "$DIR/2026-09-15-1-preparar.sql"
else
  echo "▶ 1/3 (simulación) Productos demo que se retirarían:"
  psql "$DATABASE_URL" -X -q -tAc "select '   · ' || name || ' (' || slug || ')' from products where deleted_at is null and slug in ('croissant-mantequilla','croissant-chocolate','croissant-almendra','galleta-chispas','galleta-nuez','rol-canela','rol-nutella','concha-vainilla','concha-chocolate','brownie-clasico','brownie-nuez','polvoron','cochinito','caja-6-croissants','rosca-temporada') order by name"
  echo "   Nota: sin el paso 1 aplicado, la simulación del paso 2 marca «Galleta Chispas» como existente (comparte slug con la demo)."
fi

echo "▶ 2/3 Productos"
pnpm --silent --filter @pdp/db run import -- --url "$DATABASE_URL" --file "$DIR/2026-09-15-catalogo-real.csv" \
  --entity products --mapping catalogo-real "${IMPORT_FLAGS[@]}"
echo "▶ 3/3 Precios de productos existentes"
pnpm --silent --filter @pdp/db run import -- --url "$DATABASE_URL" --file "$DIR/2026-09-15-precios.csv" \
  --entity prices --mapping catalogo-real-precios "${IMPORT_FLAGS[@]}"

psql "$DATABASE_URL" -X -q -tAc "select 'Después: ' || count(*) filter (where is_active and show_on_web) || ' productos visibles en web de ' || count(*) from products where deleted_at is null"
echo "✔ Catálogo real ($MODE) terminado en $ENV"
