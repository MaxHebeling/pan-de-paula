#!/usr/bin/env bash
# Comprueba que en el JavaScript que BAJA EL NAVEGADOR no haya secretos.
#
#   bash scripts/check-client-bundle.sh            # tras `pnpm build`
#
# Por qué sobre el bundle y no sobre el código: en Next basta que un módulo de servidor se importe
# desde un componente cliente para que su valor acabe horneado en un chunk. Eso no se ve leyendo el
# código —se ve leyendo el resultado del build—, y una vez desplegado el secreto es público para
# siempre, porque cualquiera puede descargar el chunk.
#
# Dos niveles:
#  1. PATRONES: formas de credencial reconocibles (JWT, URL de Postgres con contraseña, claves de
#     Supabase/Resend/Mercado Pago, claves privadas). Funciona en CI, donde no hay secretos reales.
#  2. VALORES REALES: si existe `.env.production` o `.env`, busca los valores EXACTOS de las variables
#     que solo deben vivir en el servidor. Es el control fuerte, y solo corre en la máquina del
#     operador, que es la única que tiene esos archivos.
#
# Nunca imprime un secreto: solo el nombre de la variable y el archivo donde apareció.
set -euo pipefail
cd "$(dirname "$0")/.."

DIRS=()
for d in apps/web/.next/static apps/admin/.next/static; do [ -d "$d" ] && DIRS+=("$d"); done
if [ ${#DIRS[@]} -eq 0 ]; then
  echo "✗ No hay build cliente que revisar (apps/*/.next/static). Corre \`pnpm build\` primero."
  exit 2
fi

FALLOS=0

echo "▶ 1/2 Formas de credencial en $(find "${DIRS[@]}" -name '*.js' | wc -l | tr -d ' ') archivos de cliente"
# `eyJhbGciOi` es la cabecera base64 de un JWT: ni el service_role ni la clave anon tienen por qué
# estar aquí, porque esta app no usa Supabase desde el navegador en absoluto.
PATRONES=(
  'postgres(ql)?://[^:@/"'"'"' ]+:[^@"'"'"' ]{6,}@'
  'sb_secret_[A-Za-z0-9_-]{10,}'
  'eyJhbGciOi[A-Za-z0-9_-]{20,}'
  're_[A-Za-z0-9]{20,}'
  'APP_USR-[0-9]{6,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'SUPABASE_SERVICE_ROLE_KEY'
)
for p in "${PATRONES[@]}"; do
  # Solo se reporta el archivo, nunca la coincidencia.
  # Ojo con dos cosas, porque juntas convertían este control en un adorno:
  #  - `--include` va ANTES de las rutas. Detrás, grep lo toma por un nombre de archivo.
  #  - el código de salida NO decide: con `--include` mal puesto, grep devolvía 2 (error) aunque sí
  #    había encontrado la coincidencia, y un `if hits=$(grep …) && [ -n "$hits" ]` la tiraba a la
  #    basura. El script imprimía ✓ con un secreto delante. Lo único que decide es si `hits` trae algo.
  hits=$(grep -rl --include='*.js' -oE "$p" "${DIRS[@]}" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "  ✗ patrón de credencial encontrado en:"
    printf '%s\n' "$hits" | sed 's/^/      /'
    FALLOS=$((FALLOS + 1))
  fi
done
[ "$FALLOS" -eq 0 ] && echo "  ✓ ninguna forma de credencial"

echo "▶ 2/2 Valores reales de las variables de servidor"
SERVIDOR=(
  DATABASE_URL MIGRATE_DATABASE_URL BACKUP_DATABASE_URL
  SESSION_SECRET CRON_SECRET
  SUPABASE_SERVICE_ROLE_KEY
  MERCADOPAGO_ACCESS_TOKEN MERCADOPAGO_WEBHOOK_SECRET
  RESEND_API_KEY
  VAPID_PRIVATE_KEY
  META_APP_SECRET META_VERIFY_TOKEN INSTAGRAM_PAGE_ACCESS_TOKEN
  ANTHROPIC_API_KEY
  BACKUP_PASSPHRASE
)
REVISADAS=0
for ENVFILE in .env.production .env.staging .env; do
  [ -f "$ENVFILE" ] || continue
  for v in "${SERVIDOR[@]}"; do
    # Se lee la línea sin exportarla al entorno de este script.
    val=$(sed -n "s/^${v}=//p" "$ENVFILE" | head -1 | sed 's/^"//; s/"$//')
    # Valores cortos o vacíos no se buscan: darían falsos positivos (p. ej. "require", "supabase").
    [ -n "$val" ] && [ ${#val} -ge 16 ] || continue
    REVISADAS=$((REVISADAS + 1))
    hits=$(grep -rl --include='*.js' -F -- "$val" "${DIRS[@]}" 2>/dev/null || true)
    if [ -n "$hits" ]; then
      echo "  ✗ el valor de $v ($ENVFILE) está en el bundle del navegador:"
      printf '%s\n' "$hits" | sed 's/^/      /'
      FALLOS=$((FALLOS + 1))
    fi
  done
done
if [ "$REVISADAS" -eq 0 ]; then
  echo "  — sin .env* local con valores: en CI solo aplica el nivel 1 (esperado)"
else
  [ "$FALLOS" -eq 0 ] && echo "  ✓ ninguno de los $REVISADAS valores de servidor aparece en el cliente"
fi

if [ "$FALLOS" -gt 0 ]; then
  echo "✗ $FALLOS hallazgo(s): hay secretos en el paquete que descarga el navegador."
  echo "  Un secreto desplegado así ya es público: hay que rotarlo, no solo quitarlo del código."
  exit 1
fi
echo "✔ El bundle del navegador no lleva secretos"
