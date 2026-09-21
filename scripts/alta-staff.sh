#!/usr/bin/env bash
# Da de alta (o actualiza) a alguien del equipo en el CRM y le manda su invitación para crear contraseña.
# No fija contraseñas conocidas y no duplica usuarios: si el correo ya existe, actualiza su rol.
#
# Uso: bash scripts/alta-staff.sh [local|staging|production] "Nombre Apellido <correo>" <rol> [--apply]
# Sin --apply solo dice qué haría.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:?entorno: local | staging | production}"
shift
if [ "$ENV" = "local" ]; then ENV_FILE=.env; else ENV_FILE=".env.$ENV"; fi
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
set -a; source "$ENV_FILE"; set +a
: "${DATABASE_URL:?Falta DATABASE_URL}"
pnpm --filter @pdp/admin run alta-staff "$@"
