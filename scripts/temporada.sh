#!/usr/bin/env bash
# Sincroniza el catálogo con la hoja de la temporada y adjunta las fotos nuevas.
#
#   bash scripts/temporada.sh [local|staging|production]           → simulación (no escribe)
#   bash scripts/temporada.sh [local|staging|production] --apply   → aplica (producción: respaldo antes)
#
# La hoja manda: sus FILAS OCULTAS son los productos que se retiran. Retirar = desactivar y sacar de
# web y caja; nunca borrar, para no perder ventas, puntos ni historial de precios.
# Idempotente: repetirlo no duplica productos ni vuelve a retirar nada.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-local}"
MODE="${2:---dry-run}"
case "$MODE" in --dry-run | --apply) ;; *) echo "Modo inválido: $MODE"; exit 2 ;; esac

HOJA="${HOJA:-packages/db/import/catalogo/2026-09-23-temporada.xlsx}"
FOTOS="${FOTOS:-packages/db/import/fotos/2026-09-23}"
[ -f "$HOJA" ] || { echo "Falta la hoja $HOJA"; exit 2; }

if [ "$ENV" = "local" ]; then ENV_FILE=.env; else ENV_FILE=".env.$ENV"; fi
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?Falta DATABASE_URL}"
if [ "${DATABASE_SSL:-disable}" = "require" ]; then
  export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"
fi

FLAGS=("$MODE")
[ "$MODE" = "--apply" ] && [ "${APP_ENV:-}" = "production" ] && FLAGS+=(--yes-production)

echo "▶ Temporada → $ENV ($MODE)"
psql "$DATABASE_URL" -X -q -tAc "select 'Antes: ' || count(*) filter (where is_active and show_on_web) || ' productos visibles en web de ' || count(*) from products where deleted_at is null and parent_id is null"

if [ "$MODE" = "--apply" ] && [ "$ENV" != "local" ]; then bash scripts/backup.sh "$ENV" temporada; fi

echo "▶ 1/2 Catálogo"
packages/db/node_modules/.bin/tsx packages/db/scripts/sync-temporada.ts \
  --file "$HOJA" --fotos "$FOTOS" --reporte "packages/db/import/reports/temporada-$(date +%Y%m%d).md" \
  ${FLAGS[@]+"${FLAGS[@]}"}

echo "▶ 2/2 Fotos"
bash scripts/fotos-productos.sh "$ENV" "$MODE" "$FOTOS"

psql "$DATABASE_URL" -X -q -tAc "select 'Después: ' || count(*) filter (where is_active and show_on_web) || ' productos visibles en web de ' || count(*) from products where deleted_at is null and parent_id is null"
