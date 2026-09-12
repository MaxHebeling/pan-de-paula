# El Pan de Paula — Sistema Operativo Digital

Monorepo de la panadería: **sitio público + tienda** (`apps/web`), **CRM/POS/producción** (`apps/admin`) y una
sola base Postgres con la lógica de negocio en funciones SQL transaccionales. Dinero en centavos, inventario
append-only, costeo de recetas como en la hoja de cálculo original, fidelización por QR, Mercado Pago e
Instagram integrados.

## Arranque local en 5 comandos

Requisitos: Node 22 (`.nvmrc`), pnpm 10, Postgres 17 local.

```bash
cp .env.example .env                       # 1. ajusta DATABASE_URL / DATABASE_URL_TEST si hace falta
pnpm install                               # 2.
createdb pan_de_paula && createdb pan_de_paula_test   # 3.
pnpm db:migrate && pnpm db:codegen && pnpm db:seed    # 4. esquema + tipos + catálogo/admin de ejemplo
pnpm dev                                   # 5. web http://localhost:3000 · admin http://localhost:3001
```

Admin de prueba: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` del `.env`.
Verificación completa antes de un PR: `pnpm verify` (lint + typecheck + tests + build).

## Estructura

```
apps/web               sitio público y tienda (Next 16)
apps/admin             CRM, POS, producción, inventario, clientes, reportes (Next 16)
packages/db            migraciones SQL (fuente de verdad), tipos Kysely generados, tests de integración, importador Sheets
packages/domain        reglas puras + esquemas zod (dinero, unidades, costeo, calendario, puntos)
packages/auth          sesiones de staff, contraseñas, permisos
packages/integrations  Mercado Pago, Meta/Instagram, email, storage, HTTP resiliente
scripts/               deploy, smoke, rollback, backup, restore-drill, checks
```

## Mapa de documentación

| Documento                                              | Para quién          | Contenido                                                                            |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)           | Equipo técnico      | Decisiones, módulos, flujos críticos, ambientes                                      |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)           | Equipo técnico      | Reglas no negociables, convenciones, comandos                                        |
| [docs/DATABASE.md](docs/DATABASE.md)                   | Equipo técnico      | Modelo por módulo, funciones SQL y su contrato jsonb, invariantes, migraciones       |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)           | Técnico / operador  | Mercado Pago, Meta/Instagram, Resend, Sentry, logger, crons: alta, webhooks, pruebas |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)             | Técnico / operador  | Cada variable de entorno: propósito, origen, obligatoriedad, Vercel                  |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)               | Operador            | Vercel (2 proyectos) + Supabase, `deploy.sh` paso a paso, CI                         |
| [docs/ROLLBACK.md](docs/ROLLBACK.md)                   | Operador            | Revertir app (Vercel), corregir DB hacia adelante, flags                             |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md)       | Operador            | PITR + `backup.sh` + simulacro, RTO/RPO, restauración real                           |
| [docs/MONITORING.md](docs/MONITORING.md)               | Operador            | Health/ready, Sentry, logs, alertas con SQL listo                                    |
| [docs/INCIDENT_RESPONSE.md](docs/INCIDENT_RESPONSE.md) | Operador / gerencia | Severidades, runbooks (MP, stock, POS, login), postmortem                            |
| [docs/RELIABILITY.md](docs/RELIABILITY.md)             | Todos               | Baseline y Definition of Done: qué existe y qué falta                                |
| [docs/MIGRATION_SHEETS.md](docs/MIGRATION_SHEETS.md)   | Dueño               | Pasar Google Sheets al sistema sin perder ni duplicar nada                           |
| [docs/POS_MANUAL.md](docs/POS_MANUAL.md)               | Mostrador           | Abrir caja, vender, cobrar, anular, cerrar                                           |
| [docs/PRODUCTION_MANUAL.md](docs/PRODUCTION_MANUAL.md) | Cocina              | Producción, mermas, conteos, recetas y costos                                        |
| [docs/ADMIN_MANUAL.md](docs/ADMIN_MANUAL.md)           | Dueño / gerencia    | Mapa del CRM ruta por ruta, roles, flags, rutinas                                    |

## Comandos frecuentes

```bash
pnpm dev | build | lint | typecheck | test | test:e2e | verify
pnpm db:migrate | db:codegen | db:seed | db:reset -- --seed | db:test
pnpm --filter @pdp/db run import -- --file hoja.xlsx --sheet Ingredientes --entity ingredients --mapping ingredientes   # dry-run; agrega --apply
pnpm check:secrets | check:env | check:migrations
pnpm deploy:staging | deploy:prod | rollback | backup | restore:drill
```

Regla de la casa: **NO TEST → NO MERGE → NO DEPLOY.**
