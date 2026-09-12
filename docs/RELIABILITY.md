# Confiabilidad — baseline y Definition of Done

Leyenda: ✅ existe en el repo y está probado · ⚠️ existe parcialmente / en construcción por otro módulo ·
⏳ requiere acción externa (cuentas, paneles, hardware) antes del go-live.

## Baseline (estado real del repositorio)

### Correctitud

| Elemento                                                                                                              | Estado | Evidencia                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | :----: | ---------------------------------------------------------------------------------- |
| Lógica crítica en funciones SQL transaccionales (venta, pago, inventario, puntos, caja, reembolso, producción, merma) |   ✅   | `packages/db/migrations/0008_transactions.sql`, `0070_import_historical_sales.sql` |
| Tests de integración de DB (POS, pedidos/pagos, inventario/producción, importación)                                   |   ✅   | `packages/db/test/*.test.ts` — 47 tests; `global-setup` recrea la base             |
| Tests unitarios de dominio (dinero, unidades, costeo, calendario, puntos)                                             |   ✅   | `packages/domain/test`                                                             |
| Paridad costeo TS ↔ SQL (`costRecipe` vs `product_cost_cents`)                                                        |   ✅   | tests de dominio y de DB                                                           |
| E2E Playwright (login, POS, checkout web)                                                                             |   ⚠️   | `apps/*/playwright.config.ts` existe; `apps/*/e2e` se crea con cada módulo de UI   |
| Idempotencia: `idempotency_key` (pedido, pago, reembolso), `(provider, external_id)`, `source_ref` importación        |   ✅   | tests `es idempotente…`, `import.test.ts`                                          |
| Dinero en centavos enteros; precios del servidor                                                                      |   ✅   | `orders_total_chk`, test "usa precio del servidor"                                 |

### Datos

| Elemento                                                                  |                 Estado                 | Evidencia                                                              |
| ------------------------------------------------------------------------- | :------------------------------------: | ---------------------------------------------------------------------- |
| Migraciones inmutables con checksum y advisory lock                       |                   ✅                   | `scripts/migrate.ts`, `scripts/check-migrations.sh`, `RELEASED`        |
| Inventario append-only + nivel reconstruible                              |                   ✅                   | triggers `forbid_change`, `rebuild_inventory_levels()`                 |
| Snapshots financieros (precio/costo por ítem, venta inmutable)            |                   ✅                   | `order_items`, `sales`                                                 |
| Auditoría de cambios (`audit_logs`) y eventos de dominio                  |                   ✅                   | trigger `audit_row_change`, `emit_event`                               |
| RLS en todas las tablas; rol `pdp_app` mínimo privilegio; anon sin acceso |                   ✅                   | `0009_security.sql`                                                    |
| Respaldo lógico + verificación + retención                                |                   ✅                   | `scripts/backup.sh`                                                    |
| Simulacro de restauración con RTO medido                                  | ✅ script / ⏳ ejecutarlo mensualmente | `scripts/restore-drill.sh`, `backups/restore-drills.log`               |
| PITR en Supabase                                                          |                   ⏳                   | plan Pro + add-on (`BACKUP_RESTORE.md`)                                |
| Importación desde Sheets con trazabilidad y dry-run                       |                   ✅                   | `import_batches`/`import_rows`, `packages/db/scripts/import-sheets.ts` |

### Entrega

| Elemento                                                                     | Estado | Evidencia                                    |
| ---------------------------------------------------------------------------- | :----: | -------------------------------------------- |
| CI: secrets, migraciones, formato, lint, typecheck, tests, audit, build, e2e |   ✅   | `.github/workflows/ci.yml`                   |
| Deploy controlado (verify → backup → migrate → deploy → smoke → tag)         |   ✅   | `scripts/deploy.sh`, `scripts/smoke.sh`      |
| Rollback de aplicación                                                       |   ✅   | `scripts/rollback.sh`                        |
| Validación de variables por ambiente                                         |   ✅   | `scripts/check-env.mjs`, `apps/*/lib/env.ts` |
| Proyectos Vercel y Supabase creados, dominios, variables cargadas            |   ⏳   | `DEPLOYMENT.md`                              |
| Protección de rama `main` (PR + CI obligatorio)                              |   ⏳   | configurar en GitHub                         |

### Observabilidad

| Elemento                                                  |                   Estado                   | Evidencia                                                                            |
| --------------------------------------------------------- | :----------------------------------------: | ------------------------------------------------------------------------------------ |
| `/api/health` y `/api/ready` en ambas apps                |                     ✅                     | `apps/*/app/api/{health,ready}/route.ts`                                             |
| Sentry inicializado con release/environment               |                     ⚠️                     | dependencia y variables listas; falta `instrumentation.ts` (módulo de integraciones) |
| Monitor de uptime externo con alerta                      |                     ⏳                     | `MONITORING.md`                                                                      |
| `job_runs` con lock + rutas cron                          |                     ⚠️                     | tabla ✅; rutas `/api/cron/*` pendientes                                             |
| `webhook_events` idempotente + consultas de alerta        | ✅ tabla / ⚠️ ruta webhook en construcción | `0007`, `MONITORING.md`                                                              |
| Notificaciones internas (stock bajo, pago rechazado, VIP) |                     ✅                     | `finalize_sale`, `record_payment`, `recompute_customer_tier`                         |

### Seguridad

| Elemento                                                                            | Estado | Evidencia                                                   |
| ----------------------------------------------------------------------------------- | :----: | ----------------------------------------------------------- |
| Auth propia: argon2id, sesiones hash en DB, bloqueo por intentos, rate limit por IP |   ✅   | `packages/auth`, `login_attempts`                           |
| Permisos granulares por rol en cada página/acción (`requireSession`)                |   ✅   | `apps/admin/lib/auth.ts`, seeds de `0001`                   |
| CSRF (Origin = Host en mutaciones) y cabeceras de seguridad                         |   ✅   | `apps/admin/proxy.ts`, `next.config.ts`                     |
| Escaneo de secretos en CI                                                           |   ✅   | `scripts/check-secrets.sh`                                  |
| Auditoría de dependencias (alta severidad falla CI)                                 |   ✅   | `pnpm audit --audit-level high --prod` en CI                |
| Firma de webhooks verificada y estado consultado a la API                           |   ⚠️   | funciones en `packages/integrations` (ruta en construcción) |
| Rotación documentada de secretos                                                    |   ✅   | `INCIDENT_RESPONSE.md` R6, `ENVIRONMENT.md`                 |

### Documentación

| Documento                                                                                                                                                                       |              Estado              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------: |
| ARCHITECTURE, CONTRIBUTING, DATABASE, ENVIRONMENT, DEPLOYMENT, ROLLBACK, BACKUP_RESTORE, MONITORING, INCIDENT_RESPONSE, MIGRATION_SHEETS, manuales POS/Producción/Admin, README |                ✅                |
| Postmortems (`docs/postmortems/`)                                                                                                                                               | se crean con el primer incidente |

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
- [ ] Smoke OK; `/api/health.version` = sha del tag; anotar en `.deploys-production.log`.
- [ ] `bash scripts/release-migrations.sh` si hubo migraciones; commit de `RELEASED`.
- [ ] Sentry sin errores nuevos en los primeros 30 min; revisar consultas de `MONITORING.md`.

### Para el go-live (una sola vez)

- [ ] Supabase producción: `pdp_app` con contraseña, pooler transaction, `DATABASE_SSL=require`, PITR activo.
- [ ] Vercel: 2 proyectos, root/build correctos, Node 22, variables de producción, dominios, auto-deploy por push desactivado.
- [ ] Rama `main` protegida (PR + CI).
- [ ] Sentry inicializado y DSN cargado; monitor de uptime en `/api/ready` de ambas apps.
- [ ] Mercado Pago productivo: webhook + secret; prueba real de $1 y reembolso.
- [ ] Meta/Instagram verificado (si se lanza el bot); Resend con dominio verificado.
- [ ] Migración desde Sheets aplicada y verificada (`MIGRATION_SHEETS.md`); hoja original archivada.
- [ ] Admin cambió la contraseña sembrada; usuarios y roles creados; caja abierta con fondo real.
- [ ] Primer `backup.sh production` y primer `restore:drill` registrados.
- [ ] Equipo capacitado con `POS_MANUAL.md` y `PRODUCTION_MANUAL.md`; ventas en papel como plan B conocido.
