#!/usr/bin/env bash
# Smoke tests post-deploy: la app responde, la base está lista, las páginas críticas cargan.
set -euo pipefail
WEB="${1:?web url}"; ADMIN="${2:?admin url}"
BYPASS=()
[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ] && BYPASS=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
check() { local url="$1" expect="${2:-200}"; local code; code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -L ${BYPASS[@]+"${BYPASS[@]}"} "$url"); if [ "$code" != "$expect" ]; then echo "✗ $url → $code (esperado $expect)"; return 1; fi; echo "✓ $url → $code"; }

# Las cabeceras de seguridad se comprueban sobre lo que SIRVE el despliegue, no sobre next.config.ts:
# así se detecta también que un proxy, un rewrite o un cambio de plataforma las haya quitado en el camino.
# Un `next.config.ts` correcto y una respuesta sin CSP se ven iguales en el código y distintos aquí.
cabeceras() {
  local url="$1" h
  h=$(curl -s -D - -o /dev/null --max-time 20 -L ${BYPASS[@]+"${BYPASS[@]}"} "$url" | tr -d '\r' | tr 'A-Z' 'a-z')
  local fallos=0
  exige() { # exige <descripción> <patrón grep -E>
    if printf '%s' "$h" | grep -qiE "$2"; then echo "  ✓ $1"; else echo "  ✗ $1"; fallos=$((fallos + 1)); fi
  }
  prohibe() {
    if printf '%s' "$h" | grep -qiE "$2"; then echo "  ✗ $1"; fallos=$((fallos + 1)); else echo "  ✓ $1"; fi
  }
  echo "· Cabeceras de $url"
  exige "Content-Security-Policy" '^content-security-policy:'
  exige "CSP: object-src 'none' (nada de plugins)" "object-src 'none'"
  exige "CSP: frame-ancestors 'none' (sin clickjacking)" "frame-ancestors 'none'"
  exige "CSP: base-uri 'self' (no se puede reescribir la base de las URLs)" "base-uri 'self'"
  exige "CSP: default-src 'self'" "default-src 'self'"
  # 'unsafe-eval' solo existe en desarrollo (React Refresh). En producción es una regresión.
  prohibe "CSP sin 'unsafe-eval'" "unsafe-eval"
  # El umbral se compara con aritmética, no con una expresión regular: intentar expresar "≥ 31536000"
  # con rangos de dígitos es justo como se cuela un falso negativo (max-age=63072000 tiene 8 dígitos
  # y no encajaba en el patrón, así que una cabecera correcta se reportaba como mala).
  local edad
  edad=$(printf '%s' "$h" | sed -n 's/^strict-transport-security:.*max-age=\([0-9]\{1,\}\).*/\1/p' | head -1)
  if [ -n "$edad" ] && [ "$edad" -ge 31536000 ]; then
    echo "  ✓ HSTS de al menos un año (max-age=$edad)"
  else
    echo "  ✗ HSTS de al menos un año (max-age=${edad:-ausente})"
    fallos=$((fallos + 1))
  fi
  exige "X-Content-Type-Options: nosniff" '^x-content-type-options: *nosniff'
  exige "X-Frame-Options: DENY" '^x-frame-options: *deny'
  exige "Referrer-Policy" '^referrer-policy:'
  exige "Permissions-Policy" '^permissions-policy:'
  prohibe "sin X-Powered-By (no se anuncia el framework)" '^x-powered-by:'
  [ "$fallos" -eq 0 ] || { echo "✗ $fallos cabecera(s) de seguridad mal en $url"; return 1; }
}

check "$WEB/api/health"
check "$WEB/api/ready"
check "$WEB/"
check "$WEB/menu"
check "$ADMIN/api/health"
check "$ADMIN/api/ready"
check "$ADMIN/login"
cabeceras "$WEB/"
cabeceras "$ADMIN/login"
echo "✔ Smoke OK"
