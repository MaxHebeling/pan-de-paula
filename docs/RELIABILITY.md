# Confiabilidad — baseline y Definition of Done

Leyenda: ✅ existe en el repo y está probado · ⚠️ existe parcialmente / en construcción por otro módulo ·
⏳ requiere acción externa (cuentas, paneles, hardware) antes del go-live.

## Baseline (estado real del repositorio)

### Correctitud

| Elemento                                                                                                              | Estado | Evidencia                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | :----: | ----------------------------------------------------------------------------------------------------------------------------- |
| Lógica crítica en funciones SQL transaccionales (venta, pago, inventario, puntos, caja, reembolso, producción, merma) |   ✅   | `packages/db/migrations/0008_transactions.sql`, `0070_import_historical_sales.sql`                                            |
| Tests de integración de DB (POS, pedidos/pagos, inventario/producción, paridad dominio↔SQL, importación)              |   ✅   | `packages/db/test/*.test.ts` — 78 tests; `global-setup` recrea la base                                                        |
| Tests unitarios de dominio (dinero, unidades, costeo, calendario, puntos)                                             |   ✅   | `packages/domain/test`                                                                                                        |
| Paridad costeo TS ↔ SQL (`costRecipe` vs `product_cost_cents`)                                                        |   ✅   | tests de dominio y de DB                                                                                                      |
| E2E Playwright (login, POS con caja, producción→inventario→pedido, clientes/cupones/reportes, tienda y club)          |   ✅   | `apps/admin/e2e/{pos,ops,customers}.spec.ts`, `apps/web/e2e/{shop,club}.spec.ts` — Chromium móvil + desktop, un worker, en CI |
| Idempotencia: `idempotency_key` (pedido, pago, reembolso), `(provider, external_id)`, `source_ref` importación        |   ✅   | tests `es idempotente…`, `import.test.ts`                                                                                     |
| Dinero en centavos enteros; precios del servidor                                                                      |   ✅   | `orders_total_chk`, test "usa precio del servidor"                                                                            |

### Datos

| Elemento                                                                                                   |                 Estado                 | Evidencia                                                                           |
| ---------------------------------------------------------------------------------------------------------- | :------------------------------------: | ----------------------------------------------------------------------------------- |
| Migraciones inmutables con checksum y advisory lock                                                        |                   ✅                   | `scripts/migrate.ts`, `scripts/check-migrations.sh`, `RELEASED`                     |
| Inventario append-only + nivel reconstruible                                                               |                   ✅                   | triggers `forbid_change`, `rebuild_inventory_levels()`                              |
| Snapshots financieros (precio/costo por ítem, venta inmutable)                                             |                   ✅                   | `order_items`, `sales`                                                              |
| Auditoría de cambios (`audit_logs`) y eventos de dominio                                                   |                   ✅                   | trigger `audit_row_change`, `emit_event`                                            |
| RLS en todas las tablas; rol `pdp_app` mínimo privilegio; anon sin acceso a tablas ni EXECUTE en funciones |                   ✅                   | `0009_security.sql`, `0015_audit_infra.sql`, `packages/db/test/audit_infra.test.ts` |
| Respaldo lógico + verificación + retención (incluye extensiones)                                           |                   ✅                   | `scripts/backup.sh`                                                                 |
| Simulacro de restauración con RTO medido (falla si faltan tablas/errores)                                  | ✅ script / ⏳ ejecutarlo mensualmente | `scripts/restore-drill.sh`, `backups/restore-drills.log`                            |
| Consultas de integridad para producción (solo lectura)                                                     |                   ✅                   | `scripts/db-integrity.sql` (`docs/MONITORING.md` §3)                                |
| PITR en Supabase                                                                                           |                   ⏳                   | plan Pro + add-on (`BACKUP_RESTORE.md`)                                             |
| Importación desde Sheets con trazabilidad y dry-run                                                        |                   ✅                   | `import_batches`/`import_rows`, `packages/db/scripts/import-sheets.ts`              |

### Entrega

| Elemento                                                                                                       | Estado | Evidencia                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------- |
| CI: secrets, migraciones, formato, lint, typecheck, tests, audit, build, e2e                                   |   ✅   | `.github/workflows/ci.yml`                                                                                                |
| Deploy controlado (verify → backup → migrate → deploy → smoke → tag)                                           |   ✅   | `scripts/deploy.sh`, `scripts/smoke.sh`                                                                                   |
| Rollback de aplicación                                                                                         |   ✅   | `scripts/rollback.sh`                                                                                                     |
| Validación de variables por ambiente                                                                           |   ✅   | `scripts/check-env.mjs`, `apps/*/lib/env.ts`                                                                              |
| Proyectos Vercel y Supabase creados, dominios, variables cargadas                                              |   ⏳   | `DEPLOYMENT.md`                                                                                                           |
| Protección de rama `main` (check de CI obligatorio, sin force-push ni borrado); `CODEOWNERS` y plantilla de PR |   ✅   | GitHub `MaxHebeling/pan-de-paula` → branch protection en `main`; `.github/CODEOWNERS`, `.github/pull_request_template.md` |

### Observabilidad

| Elemento                                                                                                                                                  |                  Estado                  | Evidencia                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------: | ------------------------------------------------------------------------------------------ |
| `/api/health` y `/api/ready` en ambas apps                                                                                                                |                    ✅                    | `apps/*/app/api/{health,ready}/route.ts`                                                   |
| Sentry inicializado con release/environment y redacción de PII                                                                                            |            ✅ código / ⏳ DSN            | `apps/*/instrumentation.ts`, `apps/*/lib/sentry-options.ts` (`scrubEvent`)                 |
| Monitor de uptime externo con alerta                                                                                                                      |                    ⏳                    | `MONITORING.md`                                                                            |
| `job_runs` con lock + crons (`webhooks-retry` */15, `sessions-purge`, `stock-alerts`, `customer-events`); locks huérfanos se liberan solos (trigger 0015) | ✅ código / ⏳ plan Vercel Pro para */15 | `packages/integrations/src/jobs.ts`, `apps/*/vercel.json`, `apps/*/app/api/cron/*`, `0015` |
| Webhooks idempotentes de Mercado Pago e Instagram + reintentos (incl. eventos huérfanos en `processing`) + conciliación de montos + consultas de alerta   |                    ✅                    | `apps/web/app/api/webhooks/*`, `apps/web/lib/webhooks/*`, `0060`, `0015`, `MONITORING.md`  |
| Smoke E2E de solo lectura contra cualquier ambiente (`pnpm smoke:e2e`)                                                                                    |                    ✅                    | `apps/*/e2e/smoke.spec.ts`, `scripts/smoke-e2e.sh`, `DEPLOYMENT.md`                        |
| Notificaciones internas (stock bajo, pago rechazado, VIP)                                                                                                 |                    ✅                    | `finalize_sale`, `record_payment`, `recompute_customer_tier`                               |

### Seguridad

| Elemento                                                                                                 | Estado | Evidencia                                                                               |
| -------------------------------------------------------------------------------------------------------- | :----: | --------------------------------------------------------------------------------------- |
| Auth propia: argon2id, sesiones hash en DB, bloqueo por intentos, rate limit por IP                      |   ✅   | `packages/auth`, `login_attempts`                                                       |
| Permisos granulares por rol en cada página/acción (`requireSession`)                                     |   ✅   | `apps/admin/lib/auth.ts`, seeds de `0001`                                               |
| CSRF (Origin = Host en mutaciones) y cabeceras de seguridad                                              |   ✅   | `apps/admin/proxy.ts`, `next.config.ts`                                                 |
| Escaneo de secretos en CI                                                                                |   ✅   | `scripts/check-secrets.sh`                                                              |
| Auditoría de dependencias (alta severidad falla CI)                                                      |   ✅   | `pnpm audit --audit-level high --prod` en CI                                            |
| Logger estructurado con redacción de secretos y tokens                                                   |   ✅   | `packages/integrations/src/logger.ts`, `packages/integrations/test/logger_jobs.test.ts` |
| Firma de webhooks verificada (`x-signature` MP, `x-hub-signature-256` Meta) y estado consultado a la API |   ✅   | `packages/integrations/src/{mercadopago,instagram}.ts`, rutas en `apps/web`             |
| Rotación documentada de secretos                                                                         |   ✅   | `INCIDENT_RESPONSE.md` R6, `ENVIRONMENT.md`                                             |

### Documentación

| Documento                                                                                                                                                                                     |              Estado              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------: |
| ARCHITECTURE, CONTRIBUTING, INTEGRATIONS, DATABASE, ENVIRONMENT, DEPLOYMENT, ROLLBACK, BACKUP_RESTORE, MONITORING, INCIDENT_RESPONSE, MIGRATION_SHEETS, manuales POS/Producción/Admin, README |                ✅                |
| Postmortems (`docs/postmortems/`)                                                                                                                                                             | se crean con el primer incidente |

## Definition of Done

### Para cualquier cambio (PR)

- [ ] Lógica que toca dinero/inventario/puntos vive en SQL transaccional (o la usa), no en TypeScript.
- [ ] Test que falla sin el cambio y pasa con él (unit en `@pdp/domain`, integración en `@pdp/db`, E2E si hay UI).
- [ ] Migración nueva en el rango del módulo, aditiva; `pnpm db:codegen` corrido; tabla nueva en `truncateAll`.
- [ ] Validación zod en servidor; `requireSession("<permiso>")` en páginas/acciones; mutaciones en `withStaff`.
- [ ] Sin secretos ni valores reales; variable nueva en `.env.example`, `turbo.json`, `check-env.mjs` y `ENVIRONMENT.md`.
- [ ] Sin `catch` vacío; errores con contexto; sin placeholders "próximamente".
- [ ] `pnpm verify` y `pnpm format:check` en verde; CI verde.
- [ ] Documentación afectada actualizada (manual de la pantalla, runbook si cambia la operación).

### Para publicar a producción

- [ ] Todo lo anterior + probado en staging con el flujo real (venta POS, pedido web con MP de prueba, webhook).
- [ ] `pnpm deploy:prod` desde `main` con árbol limpio (respaldo `pre-deploy` automático).
- [ ] Smoke OK (`smoke.sh` automático + `pnpm smoke:e2e -- <web> <admin>`); `/api/health.version` = sha del tag; anotar en `.deploys-production.log`.
- [ ] `bash scripts/release-migrations.sh` si hubo migraciones; commit de `RELEASED`.
- [ ] Sentry sin errores nuevos en los primeros 30 min; revisar consultas de `MONITORING.md`.

### Para el go-live (una sola vez)

- [ ] Supabase producción: `pdp_app` con contraseña, pooler transaction, `DATABASE_SSL=require`, PITR activo.
- [ ] Vercel: 2 proyectos, root/build correctos, Node 22, variables de producción, dominios, auto-deploy por push desactivado.
- [ ] Rama `main` protegida (PR + CI).
- [ ] DSN de Sentry cargado en ambas apps; monitor de uptime en `/api/ready` de ambas apps; plan Vercel que permita el cron `*/15` (o scheduler externo).
- [ ] Mercado Pago productivo: webhook + secret; prueba real de $1 y reembolso.
- [ ] Meta/Instagram verificado (si se lanza el bot); Resend con dominio verificado.
- [ ] Migración desde Sheets aplicada y verificada (`MIGRATION_SHEETS.md`); hoja original archivada.
- [ ] Admin cambió la contraseña sembrada; usuarios y roles creados; caja abierta con fondo real.
- [ ] Primer `backup.sh production` y primer `restore:drill` registrados; `psql -f scripts/db-integrity.sql` limpio.
- [ ] Equipo capacitado con `POS_MANUAL.md` y `PRODUCTION_MANUAL.md`; ventas en papel como plan B conocido.
