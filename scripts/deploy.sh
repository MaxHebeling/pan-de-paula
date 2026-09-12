#!/usr/bin/env bash
# Despliegue controlado: verifica → migra → despliega → smoke test → registra versión.
# Uso: bash scripts/deploy.sh staging|production
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:-staging}"
[[ "$ENV" == "staging" || "$ENV" == "production" ]] || { echo "Uso: deploy.sh staging|production"; exit 2; }

ENV_FILE=".env.$ENV"
[ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE (copia .env.example y completa). Nunca lo subas a git."; exit 2; }
set -a; source "$ENV_FILE"; set +a
export APP_ENV="$ENV"

echo "▶ [$ENV] 1/6 Verificando árbol limpio y rama"
if [ -n "$(git status --porcelain)" ]; then echo "Hay cambios sin commit. Aborta."; exit 1; fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$ENV" = "production" ] && [ "$BRANCH" != "main" ]; then echo "Producción solo se despliega desde main (estás en $BRANCH)"; exit 1; fi
SHA=$(git rev-parse --short HEAD)

echo "▶ [$ENV] 2/6 Variables de entorno"
node scripts/check-env.mjs "$ENV"

echo "▶ [$ENV] 3/6 Calidad (lint, typecheck, tests, build)"
pnpm verify

echo "▶ [$ENV] 4/6 Respaldo previo + migraciones"
if [ "$ENV" = "production" ]; then bash scripts/backup.sh production "pre-deploy-$SHA"; fi
pnpm db:migrate

echo "▶ [$ENV] 5/6 Despliegue en Vercel"
VERCEL_FLAGS=""
[ "$ENV" = "production" ] && VERCEL_FLAGS="--prod"
WEB_URL=$(cd apps/web && vercel deploy $VERCEL_FLAGS --yes 2>/dev/null | tail -1)
ADMIN_URL=$(cd apps/admin && vercel deploy $VERCEL_FLAGS --yes 2>/dev/null | tail -1)
echo "  web:   $WEB_URL"
echo "  admin: $ADMIN_URL"

echo "▶ [$ENV] 6/6 Smoke tests"
bash scripts/smoke.sh "$WEB_URL" "$ADMIN_URL"

TAG="deploy-$ENV-$(date -u +%Y%m%d-%H%M%S)-$SHA"
git tag -a "$TAG" -m "Deploy $ENV $SHA web=$WEB_URL admin=$ADMIN_URL"
git push origin "$TAG" >/dev/null 2>&1 || echo "  (no se pudo subir el tag; súbelo manualmente: git push origin $TAG)"
echo "$TAG $SHA $WEB_URL $ADMIN_URL" >> ".deploys-$ENV.log"
echo "✔ Deploy $ENV completo. LAST KNOWN GOOD = $TAG"
