#!/usr/bin/env bash
# Regenera el video promocional de punta a punta: datos de demo → capturas → música → montaje.
#
# Todo ocurre contra la base LOCAL. Los guiones se niegan a correr contra cualquier otro host, así que
# no hay forma de que esto toque producción.
#
#   bash media/promo/hacer-video.sh            # todo
#   bash media/promo/hacer-video.sh montaje    # solo música y montaje (reutiliza las capturas)
set -euo pipefail
cd "$(dirname "$0")/../.."

PASO="${1:-todo}"
export PROMO_URL="${PROMO_URL:-http://localhost:3001}"

if [ "$PASO" = "todo" ]; then
  echo "▶ 1/4 Base local con datos de demostración (ficticios)"
  pnpm --filter @pdp/db run reset --seed
  pnpm --filter @pdp/db exec tsx ../../media/promo/src/datos-demo.ts

  echo "▶ 2/4 CRM compilado y en pie"
  pnpm --filter @pdp/admin run build
  echo "   Levanta el CRM en otra terminal y vuelve a correr esto con 'capturas':"
  echo "     (cd apps/admin && set -a && . ../../.env && set +a && PORT=3001 pnpm start)"
  echo "     bash media/promo/hacer-video.sh capturas"
  exit 0
fi

if [ "$PASO" = "todo" ] || [ "$PASO" = "capturas" ]; then
  echo "▶ 3/4 Capturas del CRM real"
  curl -sf --max-time 10 "$PROMO_URL/api/ready" >/dev/null || {
    echo "El CRM no responde en $PROMO_URL. Levántalo antes."; exit 1; }
  set -a; . ./.env; set +a
  pnpm --filter @pdp/admin exec tsx ../../media/promo/src/capturar.ts
fi

echo "▶ 4/4 Música original y montaje"
cd media/promo
node --experimental-strip-types src/musica.ts
node --experimental-strip-types src/render.ts

echo
echo "✔ Listo:"
ls -lh salida/*.mp4 | awk '{print "   " $NF " (" $5 ")"}'
