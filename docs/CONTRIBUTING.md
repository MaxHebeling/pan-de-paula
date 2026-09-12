# Guía de trabajo en el repositorio

## Reglas no negociables

- **NO TEST → NO MERGE → NO DEPLOY.** Todo cambio de lógica trae test (unit en `@pdp/domain`, integración en `@pdp/db`, E2E en `apps/*/e2e`).
- **Dinero en centavos enteros.** Nunca floats. Los precios y costos se calculan en el servidor (SQL), el cliente solo previsualiza.
- **Lógica crítica en SQL transaccional.** Venta/pago/inventario/puntos/reembolso/producción/merma/caja usan las funciones de `0008_transactions.sql` (o nuevas en el mismo estilo). Nunca reimplementes esa lógica en TypeScript.
- **Migraciones inmutables y aditivas**, numeradas dentro del rango reservado del módulo (ver `packages/db/migrations/README.md`). Tras migrar: `pnpm db:codegen`.
- **Validación en servidor** con zod (`@pdp/domain` exporta esquemas compartidos). Nunca confíes en el cliente.
- **Permisos**: toda página/acción del admin llama `requireSession("<permiso>")`; toda mutación corre dentro de `withStaff(db, staffId, trx => …)` para auditoría.
- **Sin secretos en el repo.** Variables nuevas se documentan en `.env.example` (sin valores reales) y en `turbo.json` → `globalEnv`.
- **Sin `catch` vacíos.** Los errores se registran (`console.error` con contexto) y se devuelve un mensaje claro (`dbErrorMessage`).
- **Nada de placeholders "próximamente" en producción.** Si una función no está lista, no se muestra el CTA.

## Estructura

```
apps/web        sitio público + tienda (identidad El Pan de Paula, Tailwind tokens en app/globals.css)
apps/admin      CRM/POS/producción (sistema teal; tokens y clases utilitarias en app/globals.css: .btn .card .st-* .input .glass .hero)
packages/db     migraciones SQL, tipos Kysely generados, tests de integración
packages/domain lógica pura + esquemas zod (money, costing, calendar, loyalty, orders, cart, validation)
packages/auth   sesiones de staff, contraseñas, permisos
packages/integrations  Mercado Pago, Meta/Instagram, email, storage, cliente HTTP resiliente
```

## Convenciones del admin (apps/admin)

- Rutas en `app/(app)/<seccion>/…` (el layout ya exige sesión). Navegación completa declarada en `lib/nav.ts` (no la edites: implementa la página).
- Datos: server components con Kysely (`db()` de `@/lib/db`) o `sql` tagged templates. Mutaciones: server actions en `actions.ts` junto a la página, validadas con zod, envueltas en `withStaff`.
- UI: `@/components/ui` (Card, PageHeader, Stat, Badge, Table, Money, EmptyState, Alert, LinkButton). Nuevos componentes → archivos nuevos en `components/`.
- Formato: `@/lib/format` (`money`, `fmtDate`, `qty`, `pct`, `todayLocal`).
- Estados con tintes (`st-green|amber|red|blue|gray`), un solo color de marca (teal). Sin fuentes externas.
- Táctil primero en POS y producción: botones ≥ 44px, 2–3 toques por operación.

## Convenciones del sitio público (apps/web)

- Identidad derivada del logo (crema, tinta, salvia, vino, corteza) definida en `app/globals.css`. Playfair Display para títulos, Inter para texto.
- Mobile-first. Imágenes con `next/image`. Metadatos y OpenGraph por página. Sin datos sensibles en cliente.
- El sitio lee la base con el cliente de servidor (`@/lib/db`); no existe acceso público directo a la base.

## Comandos

```
pnpm dev                 # ambas apps (web :3000, admin :3001)
pnpm db:migrate | db:codegen | db:seed | db:reset -- --seed
pnpm test | typecheck | lint | build | verify
pnpm --filter @pdp/db test      # integración (usa DATABASE_URL_TEST)
pnpm backup | restore:drill | deploy:staging | deploy:prod | rollback
```

## Tests de integración en paralelo

`DATABASE_URL_TEST` puede apuntar a una base distinta por persona/agente (`postgres://localhost:5432/pdp_test_<nombre>`); el `global-setup` la recrea desde cero.
