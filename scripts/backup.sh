#!/usr/bin/env bash
# Respaldo lógico de la base (pg_dump formato custom, comprimido) + verificación de integridad.
# Uso: bash scripts/backup.sh [production|staging|local] [etiqueta]
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-local}"; LABEL="${2:-manual}"
if [ "$ENV" != "local" ]; then
  [ -f ".env.$ENV" ] || { echo "Falta .env.$ENV"; exit 2; }
  set -a; source ".env.$ENV"; set +a
else
  set -a; source .env; set +a
fi
: "${DATABASE_URL:?Falta DATABASE_URL}"
# Respaldo: usa BACKUP_DATABASE_URL si existe (pooler en modo sesión, puerto 5432); si no, DATABASE_URL.
SRC="${BACKUP_DATABASE_URL:-$DATABASE_URL}"
# TLS verificado contra la CA raíz de Supabase cuando DATABASE_SSL=require
if [ "${DATABASE_SSL:-disable}" = "require" ]; then
  export PGSSLMODE=verify-full PGSSLROOTCERT="$(pwd)/certs/supabase-root-2021-ca.pem"
fi
mkdir -p backups
STAMP=$(date -u +%Y%m%d-%H%M%S)
OUT="backups/pdp-$ENV-$STAMP-$LABEL.dump"
# Solo el esquema public (los esquemas internos de Supabase no son nuestros ni accesibles para pdp_app)
pg_dump --format=custom --no-owner --no-privileges --schema=public --enable-row-security --file="$OUT" "$SRC"
pg_restore --list "$OUT" >/dev/null   # verifica que el archivo es legible
SIZE=$(du -h "$OUT" | cut -f1)
echo "✔ Respaldo: $OUT ($SIZE)"
# Retención local: 14 más recientes por entorno
ls -t backups/pdp-$ENV-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "$STAMP $OUT $SIZE" >> "backups/backups-$ENV.log"
