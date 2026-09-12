#!/usr/bin/env bash
# Rollback de aplicación: promueve el deployment anterior en Vercel (instantáneo, sin rebuild).
# Las migraciones son aditivas/compatibles hacia atrás por política; si una migración debe revertirse,
# usa una nueva migración correctiva (ver docs/ROLLBACK.md).
# Uso: bash scripts/rollback.sh [web|admin|all] [deployment-url-o-id]
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-all}"; DEPLOY="${2:-}"
roll() {
  local app="$1"
  pushd "apps/$app" >/dev/null
  if [ -n "$DEPLOY" ]; then
    vercel rollback "$DEPLOY" --yes
  else
    echo "Últimos deployments de $app (producción):"
    vercel ls --prod 2>/dev/null | head -8
    vercel rollback --yes
  fi
  popd >/dev/null
}
case "$TARGET" in
  web) roll web;;
  admin) roll admin;;
  all) roll web; roll admin;;
  *) echo "Uso: rollback.sh [web|admin|all] [deployment]"; exit 2;;
esac
echo "✔ Rollback solicitado. Verifica con: bash scripts/smoke.sh <web-url> <admin-url>"
