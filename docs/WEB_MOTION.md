# Sistema de movimiento del sitio público (`apps/web`)

> Boulangerie contemporánea + editorial gastronómico + e-commerce de alta gama. La tecnología es invisible:
> conversión > espectáculo. Este documento describe cómo está construido el movimiento, su presupuesto de
> rendimiento, cómo apagarlo y dónde colocar fotografías reales.

## Principios (no negociables)

1. **Progresivo.** Nada esencial arranca en `opacity: 0` dependiendo de JavaScript. Todo lo que oculta o desplaza
   contenido cuelga de `html[data-motion="on"]`. Ese atributo lo fija un script inline (~200 B) al inicio de
   `<body>` (`MOTION_BOOT_SCRIPT` en `lib/motion/reducedMotion.ts`) **solo si el usuario no pidió
   `prefers-reduced-motion`**. Sin JS el atributo no existe; con reduced motion vale `"reduced"`. En ambos casos el
   sitio se ve completo y estático.
2. **Solo `transform` y `opacity`.** Sin animaciones de layout. CLS = 0.
3. **El LCP nunca parte de `opacity: 0` ni queda recortado.** La foto de la portada solo escala y cada línea del
   `h1` solo se desplaza (`translateY`, sin máscara); la tarjeta de `/mi-tarjeta` solo rota/escala.
4. **Nada en la ruta crítica.** Cero librerías de animación en el bundle inicial. Lenis se carga con `import()`
   tras `requestIdleCallback`, solo en desktop con puntero fino y sin reduced motion. GSAP, Motion y Three.js se
   evaluaron y **no se usan**: todo se resuelve con CSS, IntersectionObserver y WAAPI (`element.animate`).
5. **Limpieza obligatoria.** Cada `init*()` devuelve su función de limpieza (observers, listeners, rAF, Lenis) y
   `MotionProvider` la ejecuta al cambiar de ruta o desmontar.

## Jerarquía de movimiento

| Nivel | Dónde                                   | Qué                                                                                                 |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A     | Portada del home                        | Entrada ≈1.5 s en CSS, profundidad ±6 px (desktop) y portada fija 85svh ligada al scroll (desktop). |
| B     | Secciones del home, footer              | Revelado al hacer scroll (IntersectionObserver) con stagger ligero; títulos clave por palabras.     |
| C     | Cards, botones, carrito, categorías     | Hover/tap, tilt ≤ 1.5°, "Agregar" (nudge + punto que vuela al carrito), cajón con entrada/salida.   |
| D     | Menú, producto, checkout, pedido, club… | Casi estático: transición de página de 320 ms y microinteracciones de botón. Sin parallax ni Lenis. |

## Arquitectura

```
apps/web/lib/motion/
  config.ts          ajustes (rutas tranquilas, píxeles máximos, duraciones), onIdle(), clamp()
  reducedMotion.ts   MOTION_BOOT_SCRIPT, motionEnabled(), finePointer(), useReducedMotion(), sync del atributo
  MotionProvider.tsx orquesta por ruta: scrollReveal, tilt, parallax, magnetic, hero, Lenis (idle)
  scrollReveal.ts    revelados B: [data-reveal] → .reveal-wait (solo lo que está bajo el viewport) → .reveal-in
  textReveal.tsx     <SplitWords/> parte títulos en .word (servidor); el CSS escalona con --w
  hero.ts            profundidad del hero con [data-depth] (rAF + lerp), solo desktop
  parallax.ts        [data-parallax] ±28 px, solo desktop, lecturas y escrituras separadas por frame
  magnetic.ts        [data-magnetic] ≤ 5 px, solo desktop, nunca se aleja del cursor
  productCards.ts    initCardTilt() en [data-tilt], flyToCart(), nudgeCard()
  smoothScroll.ts    Lenis (singleton, import dinámico), pause/resume para diálogos
  pageTransition.tsx <PageTransition/> aplica .page-enter solo en navegaciones en cliente
apps/web/lib/a11y/focusTrap.ts   trapFocus() para el cajón del carrito
apps/web/app/motion.css          todas las reglas de movimiento (importado desde globals.css)
apps/web/app/cinematic.css       composición estática del home (layout, tipografía, hover/foco); sin animaciones
apps/web/components/Reveal.tsx   envoltorio server-side que solo marca data-reveal / --reveal-delay
apps/web/components/cinematic/   home: CinematicHero, EditorialStatement, Marquee, ProductShowcase, CategoryExperience,
                                 StickyStory, Timeline, NextDate, VisitUs, ClubSection, CinematicCTA, ScrollProgress,
                                 Button (PRIMARY/SECONDARY/TEXT LINK), SectionHeading, TextReveal, Plate, photos.ts
```

### Cómo funciona el revelado (B)

`Reveal` (o cualquier elemento con `data-reveal="up|fade|scale|card|left|none"`) no cambia nada en el HTML.
Al hidratar, `initScrollReveal()` observa esos elementos; **solo los que están enteros por debajo del viewport**
reciben `.reveal-wait` (opacity 0 + transform) y, al entrar en pantalla, `.reveal-in` (transición 0.8 s).
Lo que ya se ve nunca parpadea, y si el bundle no cargara nada quedaría oculto. Hijos con `.reveal-img`,
`.reveal-text` y `.word` se animan en cascada desde el CSS. `--reveal-delay` (o `data-reveal-group="80"` en el
contenedor) escalona.

### Portada (A)

`components/cinematic/CinematicHero.tsx`. Capas y quién mueve cada una (nunca dos `transform` en el mismo elemento):
`.cin-hero-media[data-depth]` → puntero (`lib/motion/hero.ts`, ±6 px) · `.cin-hero-zoom` → scroll · `img.cin-hero-img` →
entrada. Secuencia: imagen (scale 1.08→1) → `.line-in` escalonadas (0.18 s + 0.12 s por línea, solo transform) →
`.hero-sub` → `.hero-cta` → `.hero-status` → navegación de la cabecera (`.header-nav-enter`, 0.9 s; logo y carrito
nunca se ocultan). Total ≈1.5 s, sin loader.

Transición ligada al scroll (solo `min-width: 1024px`, `min-height: 620px` y navegadores con
`animation-timeline: view()`): `.cin-hero-pin` mide 185svh y la portada queda `sticky`; con `view-timeline: --hero`
la imagen escala a 1.14, el titular sube y se desvanece, aparece un velo y después "Hecho a mano." / "Horneado para
ti." (`.cin-hero-after`, decorativo). Sin soporte, en móvil, sin JS o con reduced motion la portada mide 100svh y
queda quieta.

Imagen: `getImageProps` con art direction — panorámica desde 640 px y `hero-pastries-square.webp` (recorte cuadrado de
la misma foto) en móvil. La foto ya no cubre todo el viewport en móvil: Chrome descarta como LCP las imágenes que
ocupan la pantalla completa y entonces el LCP pasa al `h1`.

Cabecera: en el home (`body:has([data-hero])`) y solo con JS (`html[data-motion]`) es transparente con texto claro
mientras la portada está detrás; `HeaderShell` fija `data-scrolled` cuando termina `[data-hero-pin]`. Antes de
hidratar no lleva el atributo; sin JS mantiene su fondo. Con el menú móvil abierto vuelve a ser sólida.

### Resto del home

| Sección                | Componente            | Movimiento                                                                                      |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| Manifiesto             | `EditorialStatement`  | Palabras con opacidad 0→1 ligada al scroll (`--p` = posición en el párrafo); fotos con parallax |
| Marquee                | `Marquee`             | Traslación lineal 70 s, decorativo (`aria-hidden`)                                              |
| Productos estrella     | `ProductShowcase`     | Revelado + parallax 0.05 en la foto; swipe nativo en móvil; "Agregar" con la secuencia de (C)   |
| Categorías             | `CategoryExperience`  | Hover/foco cambia la capa del panel (crossfade 320 ms) solo con CSS `:has`; filas atenuadas     |
| Del horno a tu mesa    | `StickyStory`         | `ProcessSteps` marca `.is-active`; capa con crossfade y barras 01–04 (`:has`)                   |
| Catálogo               | `ProductCard`         | Intensidad baja: imagen 1→1.04, CTA con micro movimiento                                        |
| Cómo pedir             | `Timeline`            | Línea `scaleX`/`scaleY` con `view-timeline`; sin soporte, transición al revelarse               |
| Próxima fecha / estado | `NextDate`, `VisitUs` | Solo revelado de sección; el punto de estado no pulsa                                           |
| Club                   | `ClubSection`         | Tarjeta con `data-reveal="card"` (rotate 2°→0, scale .95→1)                                     |
| Progreso               | `ScrollProgress`      | Barra de 2 px con `animation-timeline: scroll(root)`                                            |

Precios, textos legales, inputs, errores y botones de compra no se animan. Evaluado y descartado: cursor
personalizado (no aporta a una tienda de pan y complica el foco) y GSAP/ScrollTrigger (CSS scroll-driven +
IntersectionObserver alcanzan; 0 KB añadidos).

### Tokens

En `app/globals.css`: curvas `--ease-premium`, `--ease-reveal`, `--ease-hover`, `--ease-page` (en `@theme`) y en
`:root` contenedores (`--container-wide`, `--gutter`), ritmo (`--space-section`, `--space-block`), escala
(`--text-hero`, `--text-statement`, `--text-h2`, `--text-h3`, `--text-index`), radios (`--radius-media`,
`--radius-panel`) y tiempos (`--dur-micro` 240 ms, `--dur-hover` 320 ms, `--dur-reveal` 800 ms, `--dur-hero` 1200 ms).

### Carrito (C)

`CartDrawer` mantiene el cajón montado mientras sale (`.drawer-closing` → `drawer-out` 0.28 s) y lo desmonta por
temporizador (no depende de `animationend`, que no dispara con reduced motion). Líneas con `.drawer-line` y `--i`;
eliminación en dos tiempos (fade 180 ms + colapso de altura con WAAPI contenido en el cajón). Foco atrapado,
`Esc` cierra, foco de vuelta al disparador, `aria-modal="true"`, `data-lenis-prevent` en la lista.

`AddToCart`: `cart.add(product, qty, { open: false })` → `nudgeCard()` → `flyToCart()` (un solo `span.fly-dot`,
WAAPI, 420 ms) → `cart.open()`. Con reduced motion o sin destino visible se abre de inmediato.

### Cabecera y transición de página

`HeaderShell` (cliente) alterna `data-scrolled` con un listener pasivo + rAF; transparente arriba, fondo + blur
tras 12 px. `PageTransition` aplica `.page-enter` (opacity + 8 px, 320 ms) **solo** en navegaciones posteriores
a la primera carga.

## Presupuesto de rendimiento

Lighthouse móvil (Lantern, `next build` + `next start` local, misma máquina, mediana de 2 corridas):

| Ruta                              | Antes (perf / LCP / TBT / CLS)   | Después (perf / LCP / TBT / CLS) |
| --------------------------------- | -------------------------------- | -------------------------------- |
| `/`                               | 87–90 / 3.7–4.0 s / 19–42 ms / 0 | **92** / 3.3 s / 2 ms / 0        |
| `/menu`                           | 90 / 3.6 s / 18 ms / 0           | **92** / 3.3 s / 1 ms / 0        |
| `/producto/croissant-mantequilla` | 90 / 3.6 s / 18 ms / 0           | **93** / 3.2 s / 1 ms / 0        |

Home cinematográfico (`feat/cinematic-home-v2`, mismo método, `next start -p 3120`, 2 corridas): antes 88–89 /
3.8–3.9 s / 20–30 ms / 0 · después **88** / 3.9–4.0 s / 20–30 ms / 0; a11y, BP y SEO 100; desktop 100 (LCP 0.8 s).
JS inicial igual (12 peticiones, 269.9 → 268.9 KB); CSS 13.3 → 16.7 KB. El LCP simulado lo limita el JS del framework
(~269 KB descargado antes del LCP), no la portada.

Accesibilidad, Best Practices y SEO: 100 en las tres rutas, antes y después. (En producción con CDN y HTTP/2
los valores absolutos son mejores; lo relevante es la comparación en igualdad de condiciones.)

Reglas para mantenerlo:

- **Nada de librerías en la ruta crítica.** Si algún día se añade GSAP/Motion, debe entrar por `import()` dentro
  de `onIdle()` en `MotionProvider`, igual que Lenis.
- **El LCP del hero (`.hero-line`) no lleva `opacity`.** Cualquier cambio al hero se valida con Lighthouse antes
  y después.
- **Cuidado con el scroll programático al cargar.** Un `scroll-snap-type: x mandatory` en la fila de categorías
  provocaba un reajuste de scroll al cargar y Chrome dejaba de reportar candidatos de LCP (NO_LCP en Lighthouse).
  Se usa `snap-proximity` + `scroll-padding` igual al padding lateral.
- Sentry en el navegador se carga diferido (`instrumentation-client.ts`): los errores previos se guardan y se
  reenvían al iniciar. Eso quita ~135 KB gz del bundle inicial.

## Cómo desactivar

- **Usuario:** activar "Reducir movimiento" en el sistema operativo. El sitio lo respeta en vivo (sin recargar).
- **Todo el sistema:** quitar `MOTION_BOOT_SCRIPT` de `app/layout.tsx` (el atributo nunca será `"on"` y todo el
  CSS de movimiento queda inerte) o eliminar `<MotionProvider/>`.
- **Solo Lenis:** `MOTION.smoothScroll = false` en `lib/motion/config.ts`.
- **Solo una ruta:** añadirla a `MOTION.calmRoutes` (sin Lenis, parallax, magnetismo ni hero; sí revelados).
- **Solo un elemento:** quitar su `data-reveal` / `data-tilt` / `data-magnetic` / `data-parallax`.

## Fotografías reales (pendientes)

Hoy no hay fotografías de producto ni de proceso: se usa arte SVG con la paleta (`ProductArt`, `ProcessArt`).
Dónde colocar las fotos, sin tocar código:

| Uso                                     | Archivo                                                  | Formato recomendado         |
| --------------------------------------- | -------------------------------------------------------- | --------------------------- |
| "Del horno a tu mesa" · 01 Preparamos   | `apps/web/public/story/01-preparamos.jpg` (o .webp/.png) | 4:5, 1200×1500, < 250 KB    |
| "Del horno a tu mesa" · 02 Horneamos    | `apps/web/public/story/02-horneamos.jpg`                 | 4:5, 1200×1500              |
| "Del horno a tu mesa" · 03 Empacamos    | `apps/web/public/story/03-empacamos.jpg`                 | 4:5, 1200×1500              |
| "Del horno a tu mesa" · 04 Tú disfrutas | `apps/web/public/story/04-disfrutas.jpg`                 | 4:5, 1200×1500              |
| Producto (cards, galería, carrito)      | `product_images` desde el admin (Supabase Storage)       | 4:3 para cards, 1:1 galería |
| Categorías (panel del home)             | `categories.image_url` desde el admin (ya se pinta; sin  | 4:5, 900×1125               |
|                                         | ella usa `components/cinematic/photos.ts` o un plato)    |                             |
| Productos estrella sin foto             | `product_images` del producto (manda sobre photos.ts)    | 5:4 horizontal, 1600×1280   |

`lib/storyPhotos.ts` detecta los archivos de `public/story` en cada petición y `components/cinematic/StickyStory.tsx` pinta `next/image`
con dimensiones fijas (sin CLS). Los textos alternativos ya están escritos ahí.

## Pruebas

- `apps/web/e2e/motion.spec.ts`: reduced motion muestra todo; sin JavaScript el hero y las secciones se ven;
  con movimiento activo todos los revelados terminan visibles; el cajón se opera con teclado (foco atrapado,
  `Esc`, foco de vuelta).
- `shop.spec.ts` y `club.spec.ts` siguen pasando sin cambios de intención.
- Manual: Lighthouse móvil en `/`, `/menu`, `/producto/*` contra `next build && next start -p 3109`.
