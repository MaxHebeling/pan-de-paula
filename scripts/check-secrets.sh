#!/usr/bin/env bash
# Falla si hay secretos reales en archivos versionados.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERNS='(APP_USR-[0-9]{6,}|TEST-[0-9]{10,}-[0-9]{6}|sk_live_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{20,}|sb_secret_[A-Za-z0-9]{10,}|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9]{40,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9-]{20,})'
FILES=$(git ls-files 2>/dev/null || find . -type f -not -path './node_modules/*' -not -path './.git/*')
BAD=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.jpg|*.jpeg|*.webp|*.ico|*.woff|*.woff2|pnpm-lock.yaml) continue;; esac
  if grep -EnI "$PATTERNS" "$f" >/dev/null 2>&1; then
    echo "Posible secreto en: $f"; grep -EnI "$PATTERNS" "$f" | head -3; BAD=1
  fi
done <<< "$FILES"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo ".env está versionado — prohibido"; BAD=1; fi
[ "$BAD" -eq 0 ] && echo "OK: sin secretos en el repositorio"
exit $BAD
