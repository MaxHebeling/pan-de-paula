#!/usr/bin/env bash
# Despliegue controlado: verifica → migra → despliega → smoke test → registra versión.
# Uso: bash scripts/deploy.sh staging|production
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-staging}"
[[ "$ENV" == "staging" || "$ENV" == "production" ]] || { echo "Uso: deploy.sh staging|production"; exit 2; }

ENV_FILE=".env.$ENV"
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE (copia .env.example y completa). Nunca lo subas a git."; exit 2; }

echo "▶ [$ENV] 1/6 Verificando árbol limpio y rama"
if [ -n "$(git status --porcelain)" ]; then echo "Hay cambios sin commit. Aborta."; exit 1; fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$ENV" = "production" ] && [ "$BRANCH" != "main" ]; then echo "Producción solo se despliega desde main (estás en $BRANCH)"; exit 1; fi
SHA=$(git rev-parse --short HEAD)

echo "▶ [$ENV] 2/6 Calidad (lint, typecheck, tests, build) — con el entorno LOCAL, nunca con el de $ENV"
# Importante: los tests corren contra DATABASE_URL_TEST local. El archivo .env.$ENV se carga DESPUÉS, en un subshell.
unset NODE_ENV
pnpm verify

# A partir de aquí, entorno del destino (subshell: no contamina el resto de la sesión)
set -a; source "$ENV_FILE"; set +a
export APP_ENV="$ENV"
if [[ "$DATABASE_URL" == *localhost* || "$DATABASE_URL" == *127.0.0.1* ]]; then echo "DATABASE_URL de $ENV apunta a localhost. Aborta."; exit 1; fi

echo "▶ [$ENV] 3/6 Variables de entorno de $ENV"
node scripts/check-env.mjs "$ENV"

echo "▶ [$ENV] 4/6 Respaldo previo + migraciones"
if [ "$ENV" = "production" ]; then bash scripts/backup.sh production "pre-deploy-$SHA"; fi
pnpm db:migrate
bash scripts/check-grants.sh "${MIGRATE_DATABASE_URL:-$DATABASE_URL}"

echo "▶ [$ENV] 5/6 Despliegue en Vercel"
VERCEL_FLAGS=""
[ "$ENV" = "production" ] && VERCEL_FLAGS="--prod"
WEB_URL=$(cd apps/web && vercel deploy $VERCEL_FLAGS --yes 2>/dev/null | tail -1)
ADMIN_URL=$(cd apps/admin && vercel deploy $VERCEL_FLAGS --yes 2>/dev/null | tail -1)
echo "  web:   $WEB_URL"
echo "  admin: $ADMIN_URL"

echo "▶ [$ENV] 6/6 Smoke tests"
# Producción: contra los dominios estables (lo que ven los clientes); las URLs de deployment pueden tener
# Deployment Protection (401). Staging: URLs del deployment con bypass si VERCEL_AUTOMATION_BYPASS_SECRET existe.
SMOKE_WEB="$WEB_URL"; SMOKE_ADMIN="$ADMIN_URL"
if [ "$ENV" = "production" ]; then
  SMOKE_WEB="${NEXT_PUBLIC_SITE_URL%/}"; SMOKE_ADMIN="${NEXT_PUBLIC_ADMIN_URL%/}"
  # El alias del dominio estable se actualiza al terminar el deploy: esperar a que sirva el commit nuevo
  for i in $(seq 1 20); do
    V=$(curl -s --max-time 10 "$SMOKE_WEB/api/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    [ "$V" = "$SHA" ] && break
    sleep 6
  done
fi
bash scripts/smoke.sh "$SMOKE_WEB" "$SMOKE_ADMIN"
if [ "${SKIP_SMOKE_E2E:-0}" != "1" ]; then
  bash scripts/smoke-e2e.sh "$SMOKE_WEB" "$SMOKE_ADMIN"
fi

TAG="deploy-$ENV-$(date -u +%Y%m%d-%H%M%S)-$SHA"
git tag -a "$TAG" -m "Deploy $ENV $SHA web=$WEB_URL admin=$ADMIN_URL"
git push origin "$TAG" >/dev/null 2>&1 || echo "  (no se pudo subir el tag; súbelo manualmente: git push origin $TAG)"
echo "$TAG $SHA $WEB_URL $ADMIN_URL" >> ".deploys-$ENV.log"
echo "✔ Deploy $ENV completo. LAST KNOWN GOOD = $TAG"
