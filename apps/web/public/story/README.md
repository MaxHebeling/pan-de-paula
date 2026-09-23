# Fotografías de «Del horno a tu mesa»

Fotos reales de la panadería, tomadas por el dueño. Al existir estos archivos, `lib/storyPhotos.ts` las
detecta en cada petición y la sección cambia el arte SVG (`ProcessArt`) por la fotografía. No hay que
tocar código para activarlas ni para quitarlas.

| Paso | Archivo             | Origen (Drive)      | Qué muestra                                             |
| ---- | ------------------- | ------------------- | ------------------------------------------------------- |
| 01   | `01-preparamos.jpg` | `Boleo.jpg`         | Manos boleando y un pan de muerto ya formado en la mesa |
| 02   | `02-horneamos.jpg`  | `Resultado.jpg`     | Croissant partido a mano, con el alveolado a la vista   |
| 03   | _pendiente_         | carpeta `EMPACAMOS` | —                                                       |
| 04   | `04-disfrutas.jpg`  | `TU DISFRUTAS.jpg`  | La caja entregada, con la etiqueta de agradecimiento    |

El paso **03 Empacamos** sigue con su ilustración SVG: la subcarpeta `EMPACAMOS` de Drive no expone su
contenido públicamente. En cuanto se comparta, basta con dejar aquí `03-empacamos.jpg` y la sección lo toma
sola. La mezcla de foto e ilustración está contemplada por diseño (`Partial<Record<ProcessStepKey, …>>`).

Queda fuera, sin paso al que pertenecer, `Fermentado 2.jpg` (charolas de croissants fermentando): es una
buena foto, pero «fermentar» no es ninguno de los cuatro pasos del relato actual y etiquetarla como otra
cosa sería mentir sobre el proceso.

## Preparación

Formato 4:5, 1200 × 1500 px, JPEG calidad 86 (mozjpeg). Se respeta la orientación EXIF y el recorte se
encuadra a mano sobre el sujeto: el recorte automático por saliencia dejaba el croissant abajo y medio
cuadro de techo. Los originales de teléfono son 2256 × 4000; al reencodificar se eliminan los metadatos,
incluida la ubicación GPS.

Para reemplazar una foto basta con sobrescribir el archivo respetando la proporción 4:5.
