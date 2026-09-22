#!/usr/bin/env bash
# Monitor de disponibilidad: ¿responden la tienda y el CRM?
#
# Sondea las rutas que importan de verdad (que la base conteste, no solo que la página cargue) y
# aplica el umbral acordado en docs/MONITORING.md: UN fallo no alerta, DOS seguidos sí. Por eso cada
# sonda que falla se repite tras una pausa; así un corte de un segundo no despierta a nadie de noche.
#
#   bash scripts/monitor-check.sh                      # producción
#   WEB_URL=… ADMIN_URL=… bash scripts/monitor-check.sh
#
# Salida: 0 si todo responde, 1 si algo está caído. El detalle va a stdout y, dentro de GitHub
# Actions, también a $GITHUB_OUTPUT (estado/detalle) para que el aviso lo pueda citar.
set -uo pipefail

WEB_URL="${WEB_URL:-https://www.pandepaula.com}"
ADMIN_URL="${ADMIN_URL:-https://crm.pandepaula.com}"
REINTENTO_SEGUNDOS="${REINTENTO_SEGUNDOS:-20}"
TIMEOUT="${TIMEOUT:-20}"

fallos=()
lineas=()

# Una sonda: código HTTP esperado y, para las de salud, que el cuerpo diga "ok":true. Comprobar solo
# el 200 no basta: /api/ready responde 503 con cuerpo cuando la base no está, y una página puede
# devolver 200 con un error dentro.
sondear() {
  local url="$1" espera_json="${2:-no}" cuerpo codigo tiempo
  cuerpo=$(curl -sS -L --max-time "$TIMEOUT" -w '\n%{http_code} %{time_total}' "$url" 2>&1)
  codigo=$(printf '%s' "$cuerpo" | tail -n1 | cut -d' ' -f1)
  tiempo=$(printf '%s' "$cuerpo" | tail -n1 | cut -d' ' -f2)
  [ "$codigo" = "200" ] || { echo "HTTP ${codigo:-sin respuesta}"; return 1; }
  if [ "$espera_json" = "json" ] && ! printf '%s' "$cuerpo" | grep -q '"ok":true'; then
    echo "respondió 200 pero sin ok:true"
    return 1
  fi
  echo "${tiempo}s"
}

# El umbral: se vuelve a intentar antes de dar nada por caído.
revisar() {
  local nombre="$1" url="$2" tipo="${3:-no}" detalle
  if detalle=$(sondear "$url" "$tipo"); then
    lineas+=("✓ $nombre — $detalle")
    return 0
  fi
  sleep "$REINTENTO_SEGUNDOS"
  local segundo
  if segundo=$(sondear "$url" "$tipo"); then
    lineas+=("✓ $nombre — $segundo (falló una vez y se repuso: $detalle)")
    return 0
  fi
  lineas+=("✗ $nombre — $detalle, y al reintentar: $segundo")
  fallos+=("$nombre ($url): $segundo")
}

revisar "Tienda · base de datos" "$WEB_URL/api/ready" json
revisar "Tienda · portada" "$WEB_URL/"
revisar "Tienda · menú" "$WEB_URL/menu"
revisar "CRM · base de datos" "$ADMIN_URL/api/ready" json
revisar "CRM · entrada" "$ADMIN_URL/login"

printf '%s\n' "${lineas[@]}"

if [ ${#fallos[@]} -eq 0 ]; then
  echo "✔ Todo responde ($(date -u '+%Y-%m-%d %H:%M UTC'))"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "estado=ok" >>"$GITHUB_OUTPUT"
  exit 0
fi

echo "✗ ${#fallos[@]} servicio(s) sin responder"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "estado=caido" >>"$GITHUB_OUTPUT"
  {
    echo "detalle<<FIN"
    printf '%s\n' "${fallos[@]}"
    echo "FIN"
  } >>"$GITHUB_OUTPUT"
fi
exit 1
