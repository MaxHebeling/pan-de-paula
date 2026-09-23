# Fotografías de «Del horno a tu mesa»

Fotos reales de la panadería, tomadas por el dueño, una por cada paso del relato. Al existir estos
archivos, `lib/storyPhotos.ts` las detecta en cada petición y la sección cambia el arte SVG
(`ProcessArt`) por la fotografía. No hay que tocar código para activarlas ni para quitarlas.

| Paso | Archivo             | Origen             | Qué muestra                                                       |
| ---- | ------------------- | ------------------ | ----------------------------------------------------------------- |
| 01   | `01-preparamos.jpg` | `PREPARAMOS.jpg`   | Un panadero laminando con rodillo una plancha de masa enharinada  |
| 02   | `02-horneamos.jpg`  | `HORNEAMOS.jpg`    | Un croissant recién formado, aún crudo, a la entrada del horno    |
| 03   | `03-empacamos.jpg`  | `EMPACAMOS.jpg`    | Cajas ya empacadas con la etiqueta «Muchas gracias por tu compra» |
| 04   | `04-disfrutas.jpg`  | `TU DISFRUTAS.jpg` | Una mano sostiene la caja del pedido recién recogido              |

El texto alternativo de cada una vive en `lib/storyPhotos.ts` y describe **lo que se ve**, no lo que
diría el paso: la foto de «Horneamos» es un croissant entrando al horno, no saliendo, y decir lo
contrario sería mentirle a quien navega con lector de pantalla.

## Preparación

Formato 4:5, 1200 × 1500 px, JPEG calidad 86 (mozjpeg). Se respeta la orientación EXIF y el encuadre
se decide a mano, foto por foto: dos de los originales son horizontales (4032 × 2268 y 3365 × 2096) y
un recorte automático a vertical los habría partido por donde no es. En «Preparamos» además se cierra
el cuadro sobre las manos y la masa, porque a cuadro completo la mitad superior era mandil.

Al reencodificar se eliminan los metadatos, incluida la ubicación GPS del teléfono. Ninguna foto se
retocó ni se generó.

Para reemplazar una foto basta con sobrescribir el archivo respetando la proporción 4:5, y actualizar
su `alt` en `lib/storyPhotos.ts` si cambia lo que muestra.
