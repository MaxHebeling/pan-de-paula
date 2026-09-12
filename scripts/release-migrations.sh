#!/usr/bin/env bash
# Marca como PUBLICADAS las migraciones actuales: agrega su checksum a packages/db/migrations/RELEASED.
# A partir de ahí, scripts/check-migrations.sh (CI y deploy) falla si alguna de ellas cambia de contenido.
# Correr justo después de un deploy exitoso a producción (deploy.sh no lo hace solo: es una decisión explícita).
# Uso: bash scripts/release-migrations.sh [--check]   (--check solo lista lo que agregaría)
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=packages/db/migrations
FILE="$DIR/RELEASED"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
[ -f "$FILE" ] || printf '# Migraciones publicadas: "<archivo> <sha256>" por línea.\n' > "$FILE"
ADDED=0
while read -r f; do
  name=$(basename "$f")
  if grep -qE "^$name " "$FILE"; then
    # Ya publicada: verifica que no haya cambiado
    sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
    listed=$(grep -E "^$name " "$FILE" | awk '{print $2}')
    if [ "$sum" != "$listed" ]; then
      echo "✗ $name ya estaba publicada con otro checksum. No se puede re-publicar: crea una migración nueva."; exit 1
    fi
    continue
  fi
  sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
  if [ "$CHECK" -eq 1 ]; then echo "  + $name $sum"; else echo "$name $sum" >> "$FILE"; echo "✔ publicada $name"; fi
  ADDED=$((ADDED+1))
done < <(ls "$DIR"/[0-9][0-9][0-9][0-9]_*.sql | sort)
if [ "$CHECK" -eq 1 ]; then echo "$ADDED migración(es) pendientes de publicar (nada escrito)"; exit 0; fi
if [ "$ADDED" -eq 0 ]; then echo "Sin cambios: todas las migraciones ya estaban publicadas"; exit 0; fi
bash scripts/check-migrations.sh
echo "✔ $ADDED migración(es) publicadas. Haz commit de $FILE junto con el tag del deploy."
