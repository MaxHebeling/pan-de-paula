#!/usr/bin/env bash
# Smoke tests post-deploy: la app responde, la base está lista, las páginas críticas cargan.
set -euo pipefail
WEB="${1:?web url}"; ADMIN="${2:?admin url}"
BYPASS=()
[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ] && BYPASS=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
check() { local url="$1" expect="${2:-200}"; local code; code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -L ${BYPASS[@]+"${BYPASS[@]}"} "$url"); if [ "$code" != "$expect" ]; then echo "✗ $url → $code (esperado $expect)"; return 1; fi; echo "✓ $url → $code"; }
check "$WEB/api/health"
check "$WEB/api/ready"
check "$WEB/"
check "$WEB/menu"
check "$ADMIN/api/health"
check "$ADMIN/api/ready"
check "$ADMIN/login"
echo "✔ Smoke OK"
