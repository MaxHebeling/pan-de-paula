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
3. **El LCP nunca parte de `opacity: 0`.** El `h1` del hero solo se desplaza (`translateY`); la tarjeta de
   `/mi-tarjeta` solo rota/escala.
4. **Nada en la ruta crítica.** Cero librerías de animación en el bundle inicial. Lenis se carga con `import()`
   tras `requestIdleCallback`, solo en desktop con puntero fino y sin reduced motion. GSAP, Motion y Three.js se
   evaluaron y **no se usan**: todo se resuelve con CSS, IntersectionObserver y WAAPI (`element.animate`).
5. **Limpieza obligatoria.** Cada `init*()` devuelve su función de limpieza (observers, listeners, rAF, Lenis) y
   `MotionProvider` la ejecuta al cambiar de ruta o desmontar.

## Jerarquía de movimiento

| Nivel | Dónde                                   | Qué                                                                                                 |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A     | Hero del home                           | Secuencia de entrada ≈1.3 s en CSS puro + profundidad de 7 px siguiendo el puntero (desktop).       |
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
apps/web/components/Reveal.tsx   envoltorio server-side que solo marca data-reveal / --reveal-delay
```

### Cómo funciona el revelado (B)

`Reveal` (o cualquier elemento con `data-reveal="up|fade|scale|card|left|none"`) no cambia nada en el HTML.
Al hidratar, `initScrollReveal()` observa esos elementos; **solo los que están enteros por debajo del viewport**
reciben `.reveal-wait` (opacity 0 + transform) y, al entrar en pantalla, `.reveal-in` (transición 0.8 s).
Lo que ya se ve nunca parpadea, y si el bundle no cargara nada quedaría oculto. Hijos con `.reveal-img`,
`.reveal-text` y `.word` se animan en cascada desde el CSS. `--reveal-delay` (o `data-reveal-group="80"` en el
contenedor) escalona.

### Hero (A)

`components/Hero.tsx`: `.hero-eyebrow → .hero-line (h1) → .hero-sub → .hero-cta → .hero-status → .hero-art-enter`
con `animation-delay` escalonados (0 → 0.7 s) y `both`. El `h1` usa `hero-rise` (solo transform). Las capas
`[data-depth]` van en elementos distintos a los animados para no pisar el `transform` de la animación.

### Carrito (C)

`CartDrawer` mantiene el cajón montado mientras sale (`.drawer-closing` → `drawer-out` 0.28 s) y lo desmonta por
temporizador (no depende de `animationend`, que no dispara con reduced motion). Líneas con `.drawer-line` y `--i`;
eliminación en dos tiempos (fade 180 ms + colapso de altura con WAAPI contenido en el cajón). Foco atrapado,
`Esc` cierra, foco de vuelta al disparador, `aria-modal="true"`, `data-lenis-prevent` en la lista.

`AddToCart`: `cart.add(product, qty, { open: false })` → `nudgeCard()` → `flyToCart()` (un solo `span.fly-dot`,
WAAPI, 420 ms) → `cart.open()`. Con reduced motion o sin destino visible se abre de inmediato.

### Storytelling y "Cómo pedir"

- `components/Process.tsx` + `ProcessSteps.tsx`: en desktop la imagen es `sticky` y un IntersectionObserver de
  banda central marca `.is-active` en paso y capa; el CSS hace el crossfade/zoom. Móvil: lista vertical.
- `components/HowToOrder.tsx`: SVG con `pathLength=1` y `stroke-dashoffset` (desktop) / `scaleY` (móvil); los
  números se encienden con `--i`. Sin JS: línea dibujada y todo visible.

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
| Categorías (carrusel del home)          | `categories.image_url` desde el admin (hoy no se usa: la | 4:5, 900×1125               |
|                                         | tarjeta usa `ProductArt`; al haber fotos, `CategoryRail` |                             |
|                                         | debe pintar `c.imageUrl` con `next/image` fill)          |                             |

`lib/storyPhotos.ts` detecta los archivos de `public/story` en cada petición y `Process.tsx` pinta `next/image`
con dimensiones fijas (sin CLS). Los textos alternativos ya están escritos ahí.

## Pruebas

- `apps/web/e2e/motion.spec.ts`: reduced motion muestra todo; sin JavaScript el hero y las secciones se ven;
  con movimiento activo todos los revelados terminan visibles; el cajón se opera con teclado (foco atrapado,
  `Esc`, foco de vuelta).
- `shop.spec.ts` y `club.spec.ts` siguen pasando sin cambios de intención.
- Manual: Lighthouse móvil en `/`, `/menu`, `/producto/*` contra `next build && next start -p 3109`.
