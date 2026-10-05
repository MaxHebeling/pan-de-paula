#!/usr/bin/env bash
# Carga el entorno de un ambiente, desde el archivo `.env.<ambiente>` o desde el entorno ya presente.
#
# Se usa con `source`, no se ejecuta:
#   source "$(dirname "$0")/entorno.sh"
#   entorno_disponible production   # solo comprueba; no carga nada
#   cargar_entorno production       # carga de verdad
#
# Por qué los dos caminos: los secretos de este proyecto se movieron a 1Password, así que
# `.env.production` dejó de existir y en su lugar hay `.env.production.tpl` con referencias `op://`.
# El flujo pasa a ser:
#
#   op run --env-file=.env.production.tpl -- pnpm deploy:prod
#
# Ahí `op` ya puso las variables en el entorno y no hay ningún archivo que leer. Los scripts exigían
# el archivo, así que ese comando moría en la primera línea con «Falta .env.production» — el sistema
# quedaba sin forma de desplegar aunque las credenciales estuvieran disponibles.
#
# `DATABASE_URL` hace de centinela: es la única variable que todos necesitan. Si está, el entorno
# viene de fuera y no hace falta archivo.

# Dónde está el archivo de un ambiente ("local" usa `.env` a secas).
_archivo_entorno() {
  if [ "${1:-local}" = "local" ]; then echo ".env"; else echo ".env.$1"; fi
}

# ¿Hay con qué trabajar? Devuelve 0 si sí; si no, explica cómo y termina con 2.
# Se separa de la carga porque `deploy.sh` comprueba al principio pero carga mucho después, ya
# pasadas las pruebas: así no corre veinte minutos para morir al final por una variable que faltaba.
entorno_disponible() {
  local amb="${1:-local}" archivo
  archivo="$(_archivo_entorno "$amb")"
  [ -f "$archivo" ] && return 0
  [ -n "${DATABASE_URL:-}" ] && return 0
  echo "Falta $archivo y tampoco hay variables en el entorno."
  if [ -f "$archivo.tpl" ]; then
    echo "Este proyecto guarda sus secretos en 1Password. Corre el comando así:"
    echo "  op run --env-file=$archivo.tpl -- <tu comando>"
    echo "Si 1Password pide sesión: \`eval \$(op signin)\`."
  else
    echo "Copia .env.example y complétalo. Nunca lo subas a git."
  fi
  exit 2
}

# Carga el entorno. Con archivo, lo lee; sin archivo, se queda con lo que ya hay exportado.
cargar_entorno() {
  local amb="${1:-local}" archivo
  archivo="$(_archivo_entorno "$amb")"
  if [ -f "$archivo" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$archivo"
    set +a
  else
    entorno_disponible "$amb"
    echo "  (sin $archivo: se usan las variables que ya están en el entorno)"
  fi
}
