#!/usr/bin/env bash
# Verifica que las migraciones estén numeradas sin huecos ni duplicados y que las ya publicadas no cambien.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=packages/db/migrations
ls "$DIR" | grep -E '^[0-9]{4}_.+\.sql$' | sort > /tmp/pdp_migrations.txt
DUPS=$(cut -c1-4 /tmp/pdp_migrations.txt | uniq -d || true)
if [ -n "$DUPS" ]; then echo "Versiones duplicadas: $DUPS"; exit 1; fi
# Numeración estrictamente creciente (se permiten huecos: los módulos usan rangos reservados)
PREV=0
while read -r f; do
  V=$((10#${f:0:4}))
  if [ "$V" -le "$PREV" ]; then echo "Numeración no creciente en $f"; exit 1; fi
  PREV=$V
done < /tmp/pdp_migrations.txt
# Migraciones publicadas (listadas en packages/db/migrations/RELEASED) no pueden cambiar de checksum.
if [ -f "$DIR/RELEASED" ]; then
  while read -r name sum; do
    [ -z "$name" ] && continue
    case "$name" in \#*) continue;; esac   # comentarios
    ACTUAL=$(shasum -a 256 "$DIR/$name" | cut -d' ' -f1)
    if [ "$ACTUAL" != "$sum" ]; then echo "La migración publicada $name fue modificada. Crea una nueva migración."; exit 1; fi
  done < "$DIR/RELEASED"
fi
echo "OK: $(wc -l < /tmp/pdp_migrations.txt | tr -d ' ') migraciones válidas"
