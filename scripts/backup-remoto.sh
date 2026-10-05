#!/usr/bin/env bash
# Cifra un respaldo y lo guarda fuera de esta máquina, en un bucket PRIVADO de Supabase Storage.
#
#   bash scripts/backup-remoto.sh backups/pdp-production-20260930-120000-diario.dump
#
# Por qué cifrado: el volcado lleva nombres, teléfonos, correos y compras de clientes reales. Viaja y
# se guarda cifrado con AES-256 y una frase que solo está en los secretos (BACKUP_PASSPHRASE); ni
# Supabase ni GitHub pueden leer su contenido.
#
# Por qué NO se sube como artifact de GitHub Actions: este repositorio es público, y los artifacts de
# un repositorio público los descarga cualquiera. Un bucket privado exige la clave de servicio.
#
# El paso que hace que esto sea un respaldo y no un archivo: se descifra de vuelta y se compara el
# SHA-256 contra el original ANTES de subirlo. Un cifrado que nadie ha revertido no es un respaldo, es
# un archivo ilegible con nombre de respaldo.
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGEN="${1:?Uso: backup-remoto.sh <archivo.dump>}"
[ -s "$ORIGEN" ] || { echo "✗ $ORIGEN no existe o está vacío"; exit 2; }

: "${SUPABASE_URL:?Falta SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Falta SUPABASE_SERVICE_ROLE_KEY}"
: "${BACKUP_PASSPHRASE:?Falta BACKUP_PASSPHRASE}"
BUCKET="${BACKUP_BUCKET:-db-backups}"
RETENCION_DIAS="${BACKUP_RETENTION_DAYS:-30}"
API="${SUPABASE_URL%/}/storage/v1"
AUTH=(-H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
# 600 000 iteraciones de PBKDF2: encarece un ataque por diccionario contra la frase.
CIFRADO=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -pass env:BACKUP_PASSPHRASE)

NOMBRE="$(basename "$ORIGEN").enc"
# `mktemp -t PREFIJO` funciona en macOS pero NO en Linux: ahí `-t` trata el argumento como plantilla y
# exige al menos tres X, así que fallaba con «too few X's in template» justo en el runner. Esta forma
# —ruta completa con XXXXXXXX— se comporta igual en los dos.
DESTINO="$(mktemp "${TMPDIR:-/tmp}/pdp-backup-enc.XXXXXXXX")"
VERIFICA="$(mktemp "${TMPDIR:-/tmp}/pdp-backup-ver.XXXXXXXX")"

# macOS trae `shasum`; en Linux lo normal es `sha256sum`. Se resuelve una vez y no en cada llamada.
if command -v sha256sum >/dev/null 2>&1; then
  suma_sha256() { sha256sum "$1" | cut -d" " -f1; }
elif command -v shasum >/dev/null 2>&1; then
  suma_sha256() { shasum -a 256 "$1" | cut -d" " -f1; }
else
  echo "✗ No hay sha256sum ni shasum: sin ellos no se puede comprobar que el cifrado es reversible."
  exit 2
fi
trap 'rm -f "$DESTINO" "$VERIFICA"' EXIT

echo "▶ 1/5 Cifrando $(basename "$ORIGEN") ($(du -h "$ORIGEN" | cut -f1))"
openssl enc "${CIFRADO[@]}" -salt -in "$ORIGEN" -out "$DESTINO"

echo "▶ 2/5 Comprobando que se puede descifrar"
openssl enc -d "${CIFRADO[@]}" -in "$DESTINO" -out "$VERIFICA"
SUMA_ORIGEN=$(suma_sha256 "$ORIGEN")
SUMA_VUELTA=$(suma_sha256 "$VERIFICA")
if [ "$SUMA_ORIGEN" != "$SUMA_VUELTA" ]; then
  echo "✗ El descifrado no reproduce el original. No se sube nada."
  exit 1
fi
# Y que lo descifrado sigue siendo un volcado legible por pg_restore, no bytes cualesquiera.
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$VERIFICA" >/dev/null || { echo "✗ Lo descifrado no es un volcado legible"; exit 1; }
fi
echo "  SHA-256 coincide; pg_restore lo lee."

echo "▶ 3/5 Asegurando el bucket privado $BUCKET"
# Idempotente: si ya existe, la API responde 400 con 'Duplicate'; cualquier otro error sí importa.
CREA=$(curl -sS -o /tmp/pdp-bucket.json -w '%{http_code}' --max-time 30 -X POST "$API/bucket" \
  "${AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"name\":\"$BUCKET\",\"id\":\"$BUCKET\",\"public\":false}" || echo "000")
case "$CREA" in
  200 | 201) echo "  Bucket creado (privado)." ;;
  400 | 409) grep -q -i 'duplicate\|already exists' /tmp/pdp-bucket.json && echo "  Ya existía." || { echo "✗ No se pudo crear el bucket ($CREA)"; exit 1; } ;;
  *) echo "✗ No se pudo crear el bucket (HTTP $CREA)"; exit 1 ;;
esac
# Si el bucket existía y por error quedó público, el respaldo NO se sube: sería exponer a los clientes.
ES_PUBLICO=$(curl -sS --max-time 30 "$API/bucket/$BUCKET" "${AUTH[@]}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("public"))' 2>/dev/null || echo "?")
[ "$ES_PUBLICO" = "False" ] || { echo "✗ El bucket $BUCKET no es privado (public=$ES_PUBLICO). Abortado."; exit 1; }

echo "▶ 4/5 Subiendo $NOMBRE ($(du -h "$DESTINO" | cut -f1))"
SUBE=$(curl -sS -o /tmp/pdp-subida.json -w '%{http_code}' --max-time 600 -X POST "$API/object/$BUCKET/$NOMBRE" \
  "${AUTH[@]}" -H "Content-Type: application/octet-stream" -H "x-upsert: true" \
  --data-binary "@$DESTINO" || echo "000")
[ "$SUBE" = "200" ] || { echo "✗ La subida falló (HTTP $SUBE)"; exit 1; }

# Comprobar que del otro lado hay exactamente los bytes que se mandaron. Ojo: en la API de Storage
# `prefix` es una CARPETA, no un prefijo de nombre; para un objeto en la raíz hay que listar la raíz
# (prefix "") y buscar el nombre. Pasar el nombre como prefix devuelve una lista vacía y haría creer
# que la subida falló.
BYTES_LOCAL=$(wc -c < "$DESTINO" | tr -d ' ')
BYTES_REMOTO=$(curl -sS --max-time 60 -X POST "$API/object/list/$BUCKET" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d "{\"prefix\":\"\",\"limit\":1000,\"search\":\"$NOMBRE\"}" |
  BUSCADO="$NOMBRE" python3 -c '
import sys, json, os
for o in json.load(sys.stdin):
    if o.get("name") == os.environ["BUSCADO"]:
        print((o.get("metadata") or {}).get("size", ""))
        break
' 2>/dev/null || echo "")
if [ "$BYTES_LOCAL" != "$BYTES_REMOTO" ]; then
  echo "✗ El objeto subido mide ${BYTES_REMOTO:-nada} y el local $BYTES_LOCAL. La copia no es fiable."
  exit 1
fi
echo "  Verificado: $BYTES_REMOTO bytes en $BUCKET/$NOMBRE"

echo "▶ 5/5 Retención: borrando copias de más de $RETENCION_DIAS días"
VIEJOS=$(curl -sS --max-time 60 -X POST "$API/object/list/$BUCKET" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"prefix":"","limit":1000,"sortBy":{"column":"name","order":"asc"}}' |
  RETENCION="$RETENCION_DIAS" ACTUAL="$NOMBRE" python3 -c '
import sys, json, os, datetime
limite = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=int(os.environ["RETENCION"]))
for o in json.load(sys.stdin):
    nombre = o.get("name", "")
    # Nunca el que se acaba de subir, ni objetos sin fecha legible: preferimos guardar de más.
    if not nombre.endswith(".enc") or nombre == os.environ["ACTUAL"]:
        continue
    creado = o.get("created_at")
    if not creado:
        continue
    try:
        t = datetime.datetime.fromisoformat(creado.replace("Z", "+00:00"))
    except ValueError:
        continue
    if t < limite:
        print(nombre)
')
if [ -n "$VIEJOS" ]; then
  LISTA=$(printf '%s' "$VIEJOS" | python3 -c 'import sys,json; print(json.dumps({"prefixes":[l for l in sys.stdin.read().split("\n") if l]}))')
  BORRA=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 120 -X DELETE "$API/object/$BUCKET" \
    "${AUTH[@]}" -H "Content-Type: application/json" -d "$LISTA" || echo "000")
  # Que la limpieza falle no invalida el respaldo que ya está arriba: se avisa y se sigue.
  [ "$BORRA" = "200" ] && echo "  Borradas: $(printf '%s' "$VIEJOS" | grep -c .)" || echo "  Aviso: no se pudieron borrar las copias viejas (HTTP $BORRA)"
else
  echo "  Nada que borrar."
fi

TOTAL=$(curl -sS --max-time 60 -X POST "$API/object/list/$BUCKET" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"prefix":"","limit":1000}' |
  python3 -c 'import sys,json; print(len([o for o in json.load(sys.stdin) if o.get("name","").endswith(".enc")]))' 2>/dev/null || echo "?")
echo "✔ Respaldo remoto listo: $BUCKET/$NOMBRE · copias guardadas: $TOTAL"
