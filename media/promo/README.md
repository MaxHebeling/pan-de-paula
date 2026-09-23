# Video promocional del CRM

Pieza de 14 segundos en dos formatos, hecha con pantallas **reales** del CRM. Nada de lo que se ve
está dibujado para la cámara: son capturas del sistema corriendo, con datos de demostración
ficticios en una base local.

| Formato    | Archivo                                             | Resolución  | Duración |
| ---------- | --------------------------------------------------- | ----------- | -------- |
| Horizontal | [`salida/pan-de-paula-crm-horizontal.mp4`](salida/) | 1920 × 1080 | 14.0 s   |
| Vertical   | [`salida/pan-de-paula-crm-vertical.mp4`](salida/)   | 1080 × 1920 | 14.0 s   |

Ambos: H.264 High, `yuv420p`, 30 fps, audio AAC-LC 48 kHz estéreo, `+faststart` (arrancan a
reproducirse sin descargar el archivo completo).

## Qué se muestra, y por qué

Cuatro mensajes y un cierre, sobre las funciones que de verdad distinguen a este CRM:

| Tiempo  | Plano                   | Mensaje                       | Qué se ve                                                                        |
| ------- | ----------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| 0–2 s   | Panel                   | «Tu panadería, bajo control»  | Saludo con reloj en vivo, ventas del día y del mes, margen, cobros del día       |
| 2–4 s   | Métricas                | —                             | Barrido por las tarjetas de ventas, utilidad y pedidos abiertos                  |
| 4–6 s   | Pedidos                 | «Pedidos, caja y producción»  | Web, WhatsApp y mostrador en una sola cola, con estado y pago de cada uno        |
| 6–8 s   | Caja (interacción real) | «Identifica al cliente…»      | Se teclea el código y aparece el cliente con sus puntos, su nivel y su historial |
| 8–10 s  | Reportes                | —                             | Reporte del día con comparativo, ingresos por método de pago y por canal         |
| 10–12 s | Hoja de costos          | «El costo real de cada pieza» | Costo por pieza salido de la receta, margen y precio sugerido                    |
| 12–14 s | Cierre                  | «Solicita una demo»           | Logo original, nombre del sistema                                                |

El plano de la caja **no es una foto fija**: son 15 capturas consecutivas de la interacción real,
tomadas mientras se escribía el código del cliente, reproducidas a su ritmo.

## Regenerarlo

```bash
bash media/promo/hacer-video.sh          # base de demo → build → (levantar CRM) → capturas → montaje
bash media/promo/hacer-video.sh montaje  # solo música y montaje, reutilizando las capturas
```

Por partes, si se quiere control fino:

```bash
pnpm --filter @pdp/db run reset --seed                              # base limpia
pnpm --filter @pdp/db exec tsx ../../media/promo/src/datos-demo.ts  # datos ficticios coherentes
pnpm --filter @pdp/admin run build && (cd apps/admin && PORT=3001 pnpm start)
pnpm --filter @pdp/admin exec tsx ../../media/promo/src/capturar.ts # 37 capturas a 2×
cd media/promo
node --experimental-strip-types src/musica.ts                       # pista original (WAV)
node --experimental-strip-types src/render.ts                       # ambos MP4
node --experimental-strip-types src/render.ts horizontal            # solo uno
```

## Cómo está hecho

Sin dependencias nuevas: todo sale de lo que el repositorio ya tiene.

| Pieza                     | Herramienta                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| Datos de demostración     | Las funciones SQL del propio sistema (`register_customer`, `pos_checkout`, …) |
| Capturas e interacciones  | Playwright (el mismo que usan las pruebas E2E)                                |
| Composición de fotogramas | `sharp` (libvips), que ya viene con Next; el texto se rasteriza desde SVG     |
| Música y diseño sonoro    | Síntesis propia en Node, sin librerías                                        |
| Codificación              | `ffmpeg` del sistema, por tubería (no se escriben PNG intermedios)            |

`media/promo/` está **fuera** del workspace de pnpm a propósito: nada de esto entra al runtime de la
aplicación ni al bundle que se despliega. Su `node_modules` son enlaces a los paquetes que ya
existen en el monorepo (`.gitignore` local).

### Dirección visual

La identidad sale del producto, no de una plantilla: fondo tinta `#0b0d10`, acento turquesa `#0a9cb8`
—el mismo `--teal` del CRM—, resplandor vino `#97666c` del logo, y texto crema. La pantalla flota
como una tarjeta con filo de 1 px y sombra larga.

El movimiento está escrito a mano en `src/render.ts`: cada plano define su encuadre inicial y final,
y la cámara interpola entre ambos con suavizado. `ajustar()` cuadra cualquier encuadre a la
proporción de la tarjeta **sin deformar** la imagen. Los cortes caen en 2, 4, 6, 8, 10 y 12 s: cada
cuatro pulsos de la música.

### Por qué el vertical no es un recorte

Tiene sus propios encuadres —más cerrados, para que la letra del CRM se lea en un teléfono—, su
propia tarjeta (4:3 en vez de 16:10), y otra distribución: el texto va arriba, centrado y más grande,
y la pantalla al centro. El tercio inferior queda libre a propósito, que es donde las redes ponen sus
propios controles.

## Música

**Original, generada por `src/musica.ts`.** No hay samples ni obras de terceros, así que no hay
licencia que rastrear ni atribución pendiente: se puede usar, modificar y redistribuir junto con este
repositorio.

120 pulsos por minuto, 14 s (28 pulsos). Bombo, charles, sub, arpegio y un colchón de acordes sobre
una progresión de siete compases; barridos de ruido en cada corte de plano y un impacto en el cierre
con cola que se apaga sola. Pico en −3.7 dB y salida con `tanh` (saturación suave): ni recortes ni
golpes de volumen. El video se entiende sin sonido: no hay locución y los mensajes están en pantalla.

## Datos: ficticios, coherentes y locales

`src/datos-demo.ts` se niega a correr si `DATABASE_URL` no apunta a `localhost`. Lo que aparece en
pantalla son 14 clientes inventados, 159 ventas repartidas en 21 días, una caja abierta y cinco
pedidos en curso. Los nombres son inventados, los teléfonos usan el prefijo `555` (convención de
ficción) y los correos el dominio `example.com`, que la RFC 2606 reserva para ejemplos.

Todo se genera llamando a las funciones del sistema, no con `INSERT` directos, así que el resultado
respeta las invariantes que revisa `scripts/db-integrity.sql`: los puntos cuadran con su ledger, el
inventario con sus movimientos y los pagos con los pedidos. Por eso las cifras del video son cuentas
reales del CRM —el margen de 75 % sale de las recetas cargadas— y no números escritos a mano.

El usuario que aparece en el encabezado se llama «Paula Demo»: la marca, no una persona.

## Control de calidad

Verificado sobre los archivos finales, no sobre el proyecto:

- Duración, resolución, códec, formato de píxel y `faststart` con `ffprobe`.
- Decodificación completa de ambos archivos sin un solo error.
- `blackdetect`: ningún cuadro negro ni congelado.
- Tiras de contacto de 12 fotogramas por versión, revisadas una por una: sin textos cortados, sin
  tablas vacías, sin pantallas a medio cargar, sin barras del navegador.
- Márgenes seguros: el texto nunca toca los bordes; en vertical el tercio inferior queda libre.
