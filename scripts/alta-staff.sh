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
# shellcheck source=scripts/entorno.sh
source "$(dirname "$0")/entorno.sh"
cargar_entorno "$ENV"
: "${DATABASE_URL:?Falta DATABASE_URL}"
pnpm --filter @pdp/admin run alta-staff "$@"
