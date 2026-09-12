#!/usr/bin/env bash
# Crea/enlaza los dos proyectos de Vercel (web y admin) en el equipo indicado y carga variables desde .env.<ambiente>.
# Idempotente: si el proyecto ya existe, solo enlaza y actualiza variables.
# Uso: bash scripts/vercel-setup.sh <staging|production> [team-slug]
set -euo pipefail
cd "$(dirname "$0")/.."
ENV="${1:?staging|production}"; TEAM="${2:-max-ab784c70}"
ENV_FILE=".env.$ENV"; [ -f "$ENV_FILE" ] || { echo "Falta $ENV_FILE"; exit 2; }
VENV="production"; [ "$ENV" = "staging" ] && VENV="preview"

setup_app() {
  local app="$1" name="$2"
  pushd "apps/$app" >/dev/null
  vercel link --yes --scope "$TEAM" --project "$name" >/dev/null 2>&1 || vercel project add "$name" --scope "$TEAM" >/dev/null && vercel link --yes --scope "$TEAM" --project "$name" >/dev/null
  # Variables: una por una, sin newline (printf), sobreescribiendo si existe
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    value="${value%\"}"; value="${value#\"}"
    [ -z "$value" ] && continue
    vercel env rm "$key" "$VENV" --yes --scope "$TEAM" >/dev/null 2>&1 || true
    printf "%s" "$value" | vercel env add "$key" "$VENV" --scope "$TEAM" >/dev/null
  done < <(grep -E '^[A-Z0-9_]+=' "$ENV_FILE")
  popd >/dev/null
  echo "✔ $name ($VENV) listo"
}
setup_app web pan-de-paula-web
setup_app admin pan-de-paula-admin
cat <<MSG

Siguiente paso en el panel de Vercel (una sola vez por proyecto):
  Settings → General → Root Directory = apps/web (o apps/admin)
  Build Command = pnpm turbo run build --filter=@pdp/web (o @pdp/admin)   Install = pnpm install --frozen-lockfile   Node = 22
  Git → conectar repo MaxHebeling/pan-de-paula, Production Branch = main
MSG
