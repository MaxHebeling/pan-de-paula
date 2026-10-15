# Película de la portada · «Del amasado al aroma»

> Estado: **integración funcional pendiente de material audiovisual.** El motor, la alternativa estática, los
> textos y las pruebas están implementados; **la película final no existe todavía.** Mientras no haya archivos en
> `apps/web/public/film/`, la portada es exactamente la estática de siempre (foto real, titular y botones).

## Qué hace

Ingredientes → masa y laminado → formado → horno → croissant terminado. La portada se queda fija mientras el
visitante hace scroll y el progreso del recorrido (0–1) mueve la posición de un video pausado. El mismo progreso
elige el texto de la escena (HTML, nunca dentro del video) y el cierre con el logo oficial y los botones.

- **Entrada:** desde la primera carga se ven el titular «Pan recién horneado», «Hecho con tiempo, laminado a mano y
  preparado por pedido.», **Ver menú** y **Cómo comprar**, y la indicación «Desliza para descubrir cómo lo hacemos».
- **Recorrido:** un texto a la vez; «Ver menú» y «Saltar la historia» siempre a mano (abajo).
- **Salida:** croissant terminado + logo oficial (archivo `public/brand/logo-320.webp`, sin alterar) + botones;
  después sigue la sección existente.

## Archivos

| Archivo                                                             | Rol                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/web/components/cinematic/heroFilm.config.ts`                  | Única configuración: escenas y tramos, textos, nombres de archivo, longitud del recorrido, tiempos de espera |
| `apps/web/lib/heroFilm.ts`                                          | Servidor: detecta los archivos en `public/film/` (como `lib/storyPhotos.ts`). Sin archivos → sin película    |
| `apps/web/lib/motion/heroFilmMath.ts`                               | Cálculos puros: progreso, tiempo del video, escena, entrada, programador de búsquedas                        |
| `apps/web/lib/motion/heroFilm.ts`                                   | Controlador en el navegador (estados, carga, búsquedas, atascos, alternativa estática, limpieza)             |
| `apps/web/components/cinematic/HeroFilm.tsx`                        | Capas: video, tratamiento de legibilidad, textos, cierre, «Ver menú», «Saltar la historia»                   |
| `apps/web/components/cinematic/CinematicHero.tsx`                   | La portada estática de siempre; con `film` suma las capas y el copy de la película                           |
| `apps/web/app/cinematic.css` / `app/motion.css`                     | Composición (capas ocultas) / reglas solo con `[data-film="ready"]`                                          |
| `apps/web/e2e/hero-film.spec.ts`, `lib/motion/heroFilmMath.test.ts` | Pruebas (el E2E se omite solo si no hay película)                                                            |

### Decisiones

- **Sin GSAP ni otra librería:** `docs/WEB_MOTION.md` exige cero librerías de animación; el control del video es un
  módulo pequeño con el mismo patrón `init*()` → limpieza que el resto. Se conserva el scroll nativo (y Lenis, que ya
  existía) y la portada fija usa `position: sticky`.
- **Una sola fuente de progreso:** el controlador calcula el progreso y de ahí salen video, escena, entrada y cierre.
- **Búsquedas sin acumulación:** mientras el video busca, solo se recuerda el último destino (scroll rápido).
- **Estados:** `idle → loading → ready | failed`. Solo `ready` fija la portada; en `loading` y `failed` se ve la
  estática. Atasco de búsqueda dos veces (2.5 s), error del video o sin fotograma en 10 s → `failed` sin recargar.
- **Nunca un salto:** la portada solo se fija si el visitante sigue arriba, o si ya quedó entera por encima (al volver
  de otra página), compensando la altura agregada.
- **Solo la variante del dispositivo:** vertical en `(max-width: 900px) and (orientation: portrait)`, horizontal en el
  resto. Si falta la composición de ese formato, no se recorta la otra: portada estática.
- **No se activa** sin JS, con `prefers-reduced-motion`, con «ahorro de datos» ni en rutas tranquilas.
- **Tratamiento cálido:** degradados café/caramelo para legibilidad; sin negro dominante, sin partículas.

## Storyboard (≈15 s, 24 fps; los tramos se ajustan al montaje final)

| #   | Escena               | Tramo    | Texto                                | Plano                                                                                                                              | Evitar                                  |
| --- | -------------------- | -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | El origen            | 0–20 %   | Hecho con tiempo                     | Primerísimo plano: harina cayendo sobre la mesa de trabajo; mantequilla y masa fresca como secundarios. Luz lateral cálida y suave | Ingredientes flotando, mesa saturada    |
| 2   | El trabajo artesanal | 20–40 %  | Laminado a mano                      | La cámara acompaña el rodillo y los pliegues; acercamiento a las capas. Harina en suspensión mínima                                | Técnicas que la panadería no usa        |
| 3   | La forma             | 40–60 %  | Pieza por pieza                      | El triángulo de masa se enrolla hasta formar el croissant, movimiento continuo                                                     | Cambios de tamaño, capas o geometría    |
| 4   | El horno             | 60–82 %  | Recién horneado                      | Luz cálida; condensación del horneado hasta el dorado                                                                              | Fuego, humo abundante, aspecto quemado  |
| 5   | El resultado         | 82–100 % | (cierre con logo y botones, en HTML) | Croissant terminado sobre papel o superficie clara; se lee el laminado y la corteza. **Debe funcionar como foto fija**             | Accesorios que compitan con el producto |

Continuidad: misma luz, misma mesa y **el mismo croissant de El Pan de Paula** en todas las escenas (referencias:
`public/editorial/hero-pastries.webp`, `public/story/01-preparamos.jpg`, `02-horneamos.jpg` y las fotos del Croissant
Natural del catálogo). Las fotografías con personas no se alteran ni se regeneran. Sin texto ni logo dentro del video.

### Producción

- **Preferente:** filmar el proceso real en la panadería (es la única fuente que garantiza el producto real).
- **Híbrida:** material real + clips generados solo para ambiente o transiciones, sin cambiar la apariencia del
  croissant. Revisar clip por clip: manos, utensilios que cambian, texturas que parpadean, productos distintos.
- **Generada (Higgsfield):** requiere autorización explícita de Max (consume créditos). Partir de fotos reales del
  croissant como referencia por escena; no aceptar planos que cambien el producto.
- Dos composiciones pensadas por separado: **horizontal 16:9** (texto abajo al centro) y **vertical 9:16** (producto
  en el tercio superior, aire abajo para el texto). La vertical no es un recorte automático de la horizontal.

## Entrega de archivos

Colocar en `apps/web/public/film/` (sin tocar código):

```
del-amasado-al-aroma-horizontal.mp4   1920×1080 (o 1600×900), 24 fps, 12–18 s
del-amasado-al-aroma-horizontal.jpg   primer fotograma (póster)
del-amasado-al-aroma-vertical.mp4     1080×1920 (o 720×1280), 24 fps, misma duración
del-amasado-al-aroma-vertical.jpg     primer fotograma (póster)
```

Codificación para buscar fotogramas con fluidez (fotograma clave cada 0.5 s, sin audio, arranque rápido):

```bash
ffmpeg -i master-horizontal.mov -an -c:v libx264 -pix_fmt yuv420p -preset slow -crf 23 \
  -g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart -vf scale=1920:-2 \
  apps/web/public/film/del-amasado-al-aroma-horizontal.mp4
ffmpeg -i master-vertical.mov -an -c:v libx264 -pix_fmt yuv420p -preset slow -crf 25 \
  -g 12 -keyint_min 12 -sc_threshold 0 -movflags +faststart -vf scale=1080:-2 \
  apps/web/public/film/del-amasado-al-aroma-vertical.mp4
ffmpeg -i apps/web/public/film/del-amasado-al-aroma-horizontal.mp4 -frames:v 1 -q:v 3 \
  apps/web/public/film/del-amasado-al-aroma-horizontal.jpg
```

Presupuesto orientativo: ≤ 8 MB horizontal y ≤ 5 MB vertical. Medir antes de publicar (ver Pruebas). Si se ajusta
el montaje, actualizar los tramos `from`/`to` en `heroFilm.config.ts`.

## Probar en local

```bash
# Material provisional (claqueta «MATERIAL PROVISIONAL», no versionada):
#   apps/web/public/film/del-amasado-al-aroma-{horizontal,vertical}.provisional.{mp4,jpg}
cd apps/web && HERO_FILM_PROVISIONAL=1 pnpm build && HERO_FILM_PROVISIONAL=1 npx next start -p 3300
E2E_WEB_URL=http://localhost:3300 E2E_NO_SERVER=1 npx playwright test e2e/hero-film.spec.ts
```

Comprobar además: Safari y Chrome reales, un iPhone y un Android reales, rotación del teléfono, red lenta.

## Volver a la portada anterior

- Inmediato y sin código: quitar (o renombrar) los archivos de `public/film/` → la portada vuelve a ser la estática.
- Completo: revertir el commit de esta funcionalidad (la portada estática no cambió).

## Pendiente

1. La película (dos composiciones + pósters). Sin ella, el estado sigue siendo «integración funcional con material
   provisional».
2. Pruebas en dispositivos reales (hasta ahora: Chromium y WebKit de Playwright, escritorio e iPhone emulado).
3. Medición con la película final: peso, inicio de carga y respuesta al buscar con red lenta.
