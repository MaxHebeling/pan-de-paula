# Variables de entorno

Fuente de verdad: `.env.example` (sin valores reales); el detalle de cada proveedor externo está en `INTEGRATIONS.md` §7. Copia a `.env` en local; en Vercel se cargan por
proyecto y por ambiente. Toda variable nueva se agrega a `.env.example`, a `turbo.json → globalEnv` y, si es
obligatoria, a `scripts/check-env.mjs`.

## Validación automática

- `pnpm check:env [production|staging|development]` (`scripts/check-env.mjs`): falla si falta una obligatoria,
  si conserva el valor `CAMBIAME`, si `SESSION_SECRET` tiene menos de 32 caracteres, y en producción si
  `DATABASE_SSL=disable` o `DATABASE_URL` apunta a `localhost`.
- `scripts/deploy.sh` lo ejecuta como paso 2/6; `apps/admin/lib/env.ts` valida con zod al arrancar el admin.
- `pnpm check:secrets` (`scripts/check-secrets.sh`) impide subir tokens reales y el archivo `.env` al repo.

## Obligatoriedad

| Obligatoria en      | Variables                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Todos los ambientes | `DATABASE_URL`, `SESSION_SECRET`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ADMIN_URL`, `CRON_SECRET`       |
| Producción (además) | `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `SENTRY_DSN`, `RESEND_API_KEY`, `EMAIL_FROM` |
| Tests / CI          | `DATABASE_URL_TEST`                                                                                    |

## Catálogo

### Entorno

| Variable    | Propósito                                                                                         | Valores / dónde obtenerla                     |
| ----------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `APP_ENV`   | Ambiente lógico. Activa protecciones (reset de DB prohibido, `--yes-production` en el importador) | `development` · `staging` · `production`      |
| `NODE_ENV`  | Modo de Node/Next                                                                                 | `development` · `production` (Vercel lo fija) |
| `LOG_LEVEL` | Verbosidad de logs                                                                                | `info` (default), `debug`, `warn`, `error`    |

### Base de datos

| Variable            | Propósito                                                                 | Dónde obtenerla                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Conexión Postgres de la app y de `pnpm db:migrate / db:codegen / db:seed` | Local: `postgres://localhost:5432/pan_de_paula`. Supabase: **pooler modo transaction (puerto 6543)** con el rol `pdp_app` (ver `DEPLOYMENT.md`) |
| `DATABASE_URL_TEST` | Base que los tests de integración **recrean desde cero** en cada corrida  | Local: `postgres://localhost:5432/pan_de_paula_test` (o `pdp_test_<nombre>` por persona/agente). Nunca producción                               |
| `DATABASE_SSL`      | Modo TLS del cliente `pg`                                                 | `disable` (local) · `require` (Supabase) · `no-verify` solo para túneles                                                                        |

### Sesiones y URLs

| Variable                | Propósito                                                        | Dónde obtenerla                                                                     |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `SESSION_SECRET`        | Firma de cookies de sesión del admin (≥ 32 caracteres)           | `openssl rand -base64 48`. Distinto por ambiente; rotarlo cierra todas las sesiones |
| `NEXT_PUBLIC_SITE_URL`  | URL pública del sitio (OpenGraph, links en emails, back_urls MP) | `https://elpandepaula.mx` / URL de Vercel                                           |
| `NEXT_PUBLIC_ADMIN_URL` | URL del CRM (links en notificaciones)                            | `https://admin.elpandepaula.mx`                                                     |

### Mercado Pago (México)

| Variable                         | Propósito                                                                       | Dónde obtenerla                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `MERCADOPAGO_ACCESS_TOKEN`       | Crear preferencias de Checkout Pro y consultar pagos                            | Panel de desarrolladores → tu aplicación → Credenciales de producción (`APP_USR-…`) o de prueba (`TEST-…`) |
| `MERCADOPAGO_PUBLIC_KEY`         | Clave pública (frontend, si se usa Bricks)                                      | Misma pantalla                                                                                             |
| `MERCADOPAGO_WEBHOOK_SECRET`     | Verificar `x-signature` del webhook                                             | Panel → Webhooks → Configurar notificaciones → "Clave secreta"                                             |
| `MERCADOPAGO_POINT_DEVICE_ID`    | Terminal Point (opcional; flag `mercadopago_point`)                             | Panel → Point → dispositivos                                                                               |
| `MERCADOPAGO_QR_EXTERNAL_POS_ID` | Caja externa para QR dinámico (API de Órdenes; opcional, flag `mercadopago_qr`) | Se crea con `POST /pos` en la API de MP (`external_id`); ver `INTEGRATIONS.md` §1.5                        |

Usa credenciales de **prueba** en staging y de **producción** solo en producción.

### Meta / Instagram

| Variable                      | Propósito                                    | Dónde obtenerla                                                                                                     |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `META_APP_SECRET`             | Verificar la firma de los webhooks de Meta   | developers.facebook.com → App → Configuración básica                                                                |
| `META_VERIFY_TOKEN`           | Token que Meta envía al suscribir el webhook | Lo inventas tú (`openssl rand -hex 16`) y lo pegas en Meta                                                          |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | Enviar/leer mensajes de la cuenta            | Token de página de larga duración                                                                                   |
| `INSTAGRAM_ACCOUNT_ID`        | ID de la cuenta profesional de Instagram     | Graph API Explorer / configuración de la app                                                                        |
| `INSTAGRAM_API_BASE`          | Base del Send API (opcional)                 | Instagram Login: `https://graph.instagram.com/v25.0` (default) · Facebook Login: `https://graph.facebook.com/v25.0` |

### Email (Resend)

| Variable         | Propósito                    | Dónde obtenerla                               |
| ---------------- | ---------------------------- | --------------------------------------------- |
| `RESEND_API_KEY` | Enviar comprobantes y avisos | resend.com → API Keys (dominio verificado)    |
| `EMAIL_FROM`     | Remitente                    | `"El Pan de Paula <pedidos@elpandepaula.mx>"` |

### Notificaciones push (Web Push · VAPID)

| Variable                       | Propósito                                         | Dónde obtenerla                                                    |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Clave pública; viaja al navegador (no es secreta) | Se genera una vez con `generateVapidKeys()` de `@pdp/integrations` |
| `VAPID_PRIVATE_KEY`            | Clave privada del servidor                        | El mismo par. **Nunca** en `NEXT_PUBLIC_*`                         |
| `VAPID_SUBJECT`                | Contacto que exige el estándar                    | `mailto:bakery@pandepaula.com`                                     |

Sin ellas el portal funciona igual: no se ofrecen avisos al teléfono. El par se genera **una sola
vez** y no se cambia: cambiarlo invalida todas las suscripciones existentes y cada cliente tendría
que volver a activarlos. Van en el proyecto **web** (que es quien suscribe) y en el **admin** (que es
quien envía al mover el estado del pedido).

### Almacenamiento de imágenes

| Variable                    | Propósito                              | Valores                                                          |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `STORAGE_DRIVER`            | Dónde se guardan imágenes de productos | `local` (dev; `apps/*/public/uploads`) · `supabase` (producción) |
| `SUPABASE_URL`              | URL del proyecto Supabase              | Dashboard → Project Settings → API                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Subir a Storage desde el servidor      | Misma pantalla. **Nunca** al cliente ni a `NEXT_PUBLIC_*`        |
| `SUPABASE_STORAGE_BUCKET`   | Bucket                                 | `product-images`                                                 |

### Observabilidad

| Variable                                              | Propósito                                   | Dónde obtenerla                                                  |
| ----------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `SENTRY_DSN`                                          | Errores de servidor (release + environment) | sentry.io → Project → Client Keys                                |
| `NEXT_PUBLIC_SENTRY_DSN`                              | Errores de navegador                        | Igual (puede ser el mismo DSN)                                   |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Subir source maps en el build               | sentry.io → Settings → Auth Tokens (solo en Vercel, nunca local) |

### Jobs e IA

| Variable            | Propósito                                                        | Dónde obtenerla        |
| ------------------- | ---------------------------------------------------------------- | ---------------------- |
| `CRON_SECRET`       | Protege `/api/cron/*` (cabecera `Authorization: Bearer …`)       | `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Respuestas IA del bot de Instagram (flag `instagram_ai_replies`) | console.anthropic.com  |

### Seed y E2E (solo local/CI)

| Variable                                                  | Propósito                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`                | Usuario `super_admin` creado por `pnpm db:seed` (en producción queda con `must_change_password`) |
| `E2E_BASE_URL` / `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | Playwright                                                                                       |

## Cargarlas en Vercel

Dos proyectos (`pan-de-paula-web`, `pan-de-paula-admin`) → **Settings → Environment Variables**. Marca el
ambiente correcto (Production / Preview) y usa valores distintos por ambiente (credenciales de prueba de MP en
Preview). Por CLI, desde la carpeta de cada app:

```bash
cd apps/admin
printf "%s" "$VALOR" | vercel env add SESSION_SECRET production   # printf: evita el salto de línea final
vercel env ls
vercel env pull .env.vercel.local                                  # solo para inspeccionar; no lo subas
```

Reglas:

- `vercel env rm NOMBRE` borra la variable de **todos** los ambientes si no indicas cuál: haz `vercel env pull` antes.
- Si usas la integración Vercel↔Supabase, acota los ambientes de la conexión; de lo contrario reescribe `DATABASE_URL`.
- Tras cambiar una variable hay que **redeployar** (las funciones leen el entorno en build/arranque).
- Los archivos `.env.staging` / `.env.production` que usa `scripts/deploy.sh` viven **solo en tu máquina**
  (están en `.gitignore`); contienen la `DATABASE_URL` con la que se corren migraciones y respaldos.
