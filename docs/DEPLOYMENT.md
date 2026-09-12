# Despliegue

Dos apps Next 16 en Vercel + una base Postgres en Supabase por ambiente. El despliegue se hace con
`scripts/deploy.sh` desde tu máquina (no desde el push de git) para garantizar el orden
**verificar → respaldar → migrar → desplegar → smoke → etiquetar**.

## Topología

| Ambiente   | Base de datos                   | Vercel                                                           | Comando                                |
| ---------- | ------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| staging    | Supabase `pan-de-paula-staging` | deployments preview de `pan-de-paula-web` y `pan-de-paula-admin` | `pnpm deploy:staging`                  |
| production | Supabase `pan-de-paula`         | deployments de producción de ambos proyectos                     | `pnpm deploy:prod` (solo desde `main`) |

## Preparación única

### Supabase (por ambiente)

1. Crear el proyecto (región cercana a Tijuana: `us-west-1`). Anotar la contraseña del usuario `postgres`.
2. Aplicar migraciones **como owner** la primera vez: exporta `DATABASE_URL` con la cadena directa
   (puerto 5432, usuario `postgres`) y corre `pnpm db:migrate`. `0009_security.sql` crea el rol `pdp_app`.
3. Ponerle contraseña al rol de la app (en SQL Editor):
   ```sql
   alter role pdp_app with password '<contraseña-larga>';
   ```
4. Construir la `DATABASE_URL` de la app con el **pooler en modo transaction** (Project Settings → Database →
   Connection pooling, puerto **6543**), usuario `pdp_app.<project-ref>` y `DATABASE_SSL=require`:
   ```
   postgres://pdp_app.<ref>:<contraseña>@aws-0-us-west-1.pooler.supabase.com:6543/postgres
   ```
   Las migraciones y respaldos (`deploy.sh`, `backup.sh`) también funcionan por el pooler, pero si una
   migración necesita `create role`/`alter default privileges` se corre con el usuario `postgres` por conexión directa.
5. Storage: bucket `product-images` (público de lectura) si `STORAGE_DRIVER=supabase`.
6. Backups: en el plan Pro activar **PITR** (ver `BACKUP_RESTORE.md`).
7. Seed inicial: `pnpm db:seed` con `SEED_ADMIN_EMAIL/PASSWORD` del ambiente (en producción el admin nace con
   `must_change_password`).

### Vercel (dos proyectos)

| Ajuste                     | `pan-de-paula-web`                       | `pan-de-paula-admin`                       |
| -------------------------- | ---------------------------------------- | ------------------------------------------ |
| Root Directory             | `apps/web`                               | `apps/admin`                               |
| Framework                  | Next.js                                  | Next.js                                    |
| Install Command            | `pnpm install --frozen-lockfile`         | `pnpm install --frozen-lockfile`           |
| Build Command              | `pnpm turbo run build --filter=@pdp/web` | `pnpm turbo run build --filter=@pdp/admin` |
| Node.js Version            | 22 (`.nvmrc`)                            | 22                                         |
| Include files outside root | activado (monorepo)                      | activado                                   |
| Dominio                    | `elpandepaula.mx`                        | `admin.elpandepaula.mx`                    |

Variables de entorno: ver `ENVIRONMENT.md` e `INTEGRATIONS.md` §7 (mismo `DATABASE_URL` en ambos proyectos; `SESSION_SECRET`,
`MERCADOPAGO_*`, `META_*`, `RESEND_*`, `SENTRY_*`, `CRON_SECRET`, `STORAGE_*`). Marca Production y Preview
por separado (credenciales de prueba de Mercado Pago en Preview).

Desactiva el auto-deploy por push del proyecto (Settings → Git → Ignored Build Step `exit 0`, o desconecta el
repo) para que **la única vía a producción sea `deploy.sh`**; así nunca sube código sin migrar primero.

Vincula cada carpeta con su proyecto una vez: `cd apps/web && vercel link`, `cd apps/admin && vercel link`
(crea `apps/*/.vercel`, ignorado en git). Requiere `vercel` CLI autenticado.

### Archivos de entorno locales

`deploy.sh` lee `.env.staging` o `.env.production` en la raíz (ignorados por git). Contienen al menos
`DATABASE_URL`, `DATABASE_SSL=require`, `SESSION_SECRET`, `NEXT_PUBLIC_*`, `CRON_SECRET` y, en producción,
`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `SENTRY_DSN`, `RESEND_API_KEY`, `EMAIL_FROM`
(`scripts/check-env.mjs` los exige).

## Qué hace `scripts/deploy.sh <staging|production>`

1. **Árbol limpio y rama**: aborta si hay cambios sin commit; producción solo desde `main`.
2. **Variables**: `node scripts/check-env.mjs <env>`.
3. **Calidad**: `pnpm verify` = lint + typecheck + tests (unit + integración con `DATABASE_URL_TEST` local) + build.
4. **Respaldo previo (solo producción)**: `scripts/backup.sh production pre-deploy-<sha>`; después `pnpm db:migrate`
   contra la base del ambiente. Las migraciones son aditivas, así que la app vieja sigue funcionando mientras se despliega.
5. **Vercel**: `vercel deploy --yes` en `apps/web` y `apps/admin` (`--prod` en producción). Imprime ambas URLs.
6. **Smoke**: `scripts/smoke.sh <web> <admin>` — `/api/health`, `/api/ready`, `/`, `/menu` en web; `/api/health`,
   `/api/ready`, `/login` en admin. Cualquier código ≠ 200 falla el deploy (la app ya está publicada: haz rollback).
7. **Etiqueta**: tag `deploy-<env>-<AAAAMMDD-HHMMSS>-<sha>` (se sube a origin) y línea en `.deploys-<env>.log`
   (ignorado en git). Ese tag es el **LAST KNOWN GOOD** para `ROLLBACK.md`.

Tras el primer deploy a producción, y cada vez que publiques migraciones nuevas:

```bash
bash scripts/release-migrations.sh   # agrega checksums a packages/db/migrations/RELEASED
git add packages/db/migrations/RELEASED && git commit -m "chore: migraciones publicadas <tag>"
```

A partir de ahí CI rechaza cualquier edición de esas migraciones.

## Flujo recomendado

```
rama → PR → CI verde (lint, typecheck, tests, build, e2e) → merge a main
  → pnpm deploy:staging  → probar en staging (POS, pedido web con MP de prueba, webhook)
  → pnpm deploy:prod     → smoke automático → verificar /api/health.version == sha
  → bash scripts/release-migrations.sh (si hubo migraciones)
```

## Verificar la versión desplegada

`GET /api/health` en cada app devuelve `{ ok, app, version, time }`; `version` = `VERCEL_GIT_COMMIT_SHA`
(7 caracteres) o `dev`. `GET /api/ready` devuelve 503 si la base no responde o no hay migraciones.

```bash
curl -s https://admin.elpandepaula.mx/api/health | jq .version
git tag --list 'deploy-production-*' | tail -3
```

## CI (`.github/workflows/ci.yml`)

En cada push a `main` y PR: Postgres 17 como servicio → `pnpm install --frozen-lockfile` → `check:secrets` →
`check:migrations` → crear bases → `db:migrate` + `db:codegen` + `db:seed` → `format:check` → `lint` →
`typecheck` → `test` → `pnpm audit --audit-level high --prod` → `build` → E2E Playwright (reporte como artifact
si falla). **NO TEST → NO MERGE → NO DEPLOY.**

## Pendientes externos para el primer go-live

- Crear los dos proyectos Supabase y los dos proyectos Vercel con los ajustes de arriba.
- Dominios y DNS; certificado automático de Vercel.
- Mercado Pago: aplicación productiva, webhook apuntando a `https://elpandepaula.mx/api/webhooks/mercadopago`
  (la ruta ya existe; responde al GET de validación de MP) y `MERCADOPAGO_WEBHOOK_SECRET`. Ver `INTEGRATIONS.md` §1.
- Meta: app, verificación del webhook `https://elpandepaula.mx/api/webhooks/instagram` (`META_VERIFY_TOKEN`), tokens. Ver `INTEGRATIONS.md` §2.
- Sentry: proyecto y DSN (el código ya inicializa Sentry en ambas apps). Resend: dominio verificado.
- Crons: `apps/web/vercel.json` (`webhooks-retry` cada 15 min) y `apps/admin/vercel.json` (`sessions-purge`
  diario). Vercel Hobby solo ejecuta crons diarios: para el `*/15` hace falta plan Pro o un scheduler externo
  que llame la ruta con `Authorization: Bearer <CRON_SECRET>`.
- Activar PITR en Supabase y programar el simulacro mensual de restauración.
