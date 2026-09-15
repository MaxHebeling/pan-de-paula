#!/usr/bin/env bash
# Asigna las fotos de producto de un lote (packages/db/import/fotos/<fecha>) con la misma subida que el admin.
# Uso: bash scripts/fotos-productos.sh [local|staging|production] [--apply] [carpeta]
# Simula por defecto. Idempotente: los productos que ya tienen imagen no se tocan.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-local}"
MODE="${2:---dry-run}"
DIR="${3:-packages/db/import/fotos/2026-09-15}"
case "$MODE" in --dry-run | --apply) ;; *) echo "Modo inválido: $MODE"; exit 2 ;; esac
if [ "$ENV" = "local" ]; then ENV_FILE=.env; else ENV_FILE=".env.$ENV"; fi
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?Falta DATABASE_URL}"
if [ "${DATABASE_SSL:-disable}" = "require" ]; then
  export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"
fi
FLAGS=()
if [ "$MODE" = "--apply" ]; then
  FLAGS+=(--apply)
  [ "${APP_ENV:-}" = "production" ] && FLAGS+=(--yes-production)
  if [ "$ENV" != "local" ]; then bash scripts/backup.sh "$ENV" fotos-productos; fi
fi
echo "▶ Fotos de producto → $ENV ($MODE) · almacenamiento: ${STORAGE_DRIVER:-local}"
packages/db/node_modules/.bin/tsx packages/integrations/scripts/product-photos.ts --dir "$DIR" ${FLAGS[@]+"${FLAGS[@]}"}
