#!/usr/bin/env bash
# Smoke E2E permanente (SOLO LECTURA) contra un ambiente ya desplegado: health, ready, home, menú, un producto,
# /unete, manifest, sitemap y, en admin, login + dashboard si hay E2E_ADMIN_EMAIL/PASSWORD.
# Uso: pnpm smoke:e2e -- <web-url> <admin-url>        (ej. https://elpandepaula.mx https://admin.elpandepaula.mx)
#      E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... pnpm smoke:e2e -- <web> <admin>   # además prueba el login
# Complementa scripts/smoke.sh (curl de códigos HTTP); no lo sustituye.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB="${1:-${E2E_WEB_URL:-}}"; ADMIN="${2:-${E2E_BASE_URL:-}}"
[ -n "$WEB" ] && [ -n "$ADMIN" ] || { echo "Uso: pnpm smoke:e2e -- <web-url> <admin-url>"; exit 2; }
WEB="${WEB%/}"; ADMIN="${ADMIN%/}"
PROJECT="${SMOKE_PROJECT:-desktop}"
# Contra un ambiente desplegado no se carga el .env local (playwright.config.ts lo omite con esto).
export E2E_NO_SERVER=1
echo "▶ smoke web   → $WEB"
E2E_WEB_URL="$WEB" pnpm --filter @pdp/web exec playwright test smoke.spec.ts --grep @smoke --project="$PROJECT" --reporter=list
echo "▶ smoke admin → $ADMIN"
E2E_BASE_URL="$ADMIN" pnpm --filter @pdp/admin exec playwright test smoke.spec.ts --grep @smoke --project="$PROJECT" --reporter=list
echo "✔ Smoke E2E OK"
