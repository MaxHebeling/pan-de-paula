#!/usr/bin/env bash
# Invita al portal a clientes que YA existen (los registrados antes de que el portal existiera).
# No crea clientes, no duplica y no reemplaza un correo ya capturado.
#
# Uso: bash scripts/invitar-portal.sh [local|staging|production] PDP-000002=correo@dominio.com [...] [--apply]
# Sin --apply solo dice qué haría. Con --apply captura el correo que falte, crea el enlace de acceso
# (un solo uso) y lo envía. El enlace nunca se imprime.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:?entorno: local | staging | production}"
shift
# shellcheck source=scripts/entorno.sh
source "$(dirname "$0")/entorno.sh"
cargar_entorno "$ENV"
: "${DATABASE_URL:?Falta DATABASE_URL}"
pnpm --filter @pdp/admin run invitar-portal "$@"
