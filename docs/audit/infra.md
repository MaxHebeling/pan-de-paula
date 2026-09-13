# Auditoría 360° — Integraciones, webhooks, jobs, emails, importador, base de datos, build/CI, health y smoke

> Rama `audit/infra` (rebasada sobre `main` 138d448, que ya incluye 0080 + `_post_migrate.sql` + `check-grants.sh` y la auditoría de catálogo 0014/0041).
> Fecha: 2026-09-12. Todo se ejecutó **en local** (Postgres 17, `pdp_audit_infra_dev` con seed + demo, bases de test
> `pdp_test_audit_infra` y `_web`, servidores `next start` en 3115/3116). **Nada se ejecutó contra staging ni producción.**
> Criterio: PASS solo con evidencia ejecutada; BLOCKED cuando exige credenciales reales (se verificó con fetch
> mockeado, firmas calculadas y fixtures).

**Health score del área: 87/100** (estimado antes de la auditoría: 68/100). Detalle al final.

---

## 1. Inventario

| Tipo               | Elemento                                                                                                                                                                                                          | Ubicación                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Integración        | Mercado Pago (preferencias, `GET /v1/payments`, reembolsos, Point y QR vía `/v1/orders`, firma `x-signature`)                                                                                                     | `packages/integrations/src/mercadopago.ts`                                                    |
| Integración        | Meta/Instagram (challenge, `X-Hub-Signature-256`, parseo, Send API, bot de reglas + IA Anthropic opcional)                                                                                                        | `packages/integrations/src/instagram.ts`                                                      |
| Integración        | Resend (`sendEmail` + 3 plantillas)                                                                                                                                                                               | `packages/integrations/src/email.ts`                                                          |
| Integración        | Storage local / Supabase Storage                                                                                                                                                                                  | `packages/integrations/src/storage.ts`                                                        |
| Integración        | Sentry (server/edge/client, `scrubEvent`)                                                                                                                                                                         | `apps/*/instrumentation*.ts`, `apps/*/lib/sentry-options.ts`                                  |
| Transversal        | `fetchWithResilience` (timeout, reintentos, breaker), logger con redacción, feature flags                                                                                                                         | `packages/integrations/src/{http,logger,flags}.ts`                                            |
| Webhook            | `POST/GET /api/webhooks/mercadopago` (maxDuration 20 s)                                                                                                                                                           | `apps/web/app/api/webhooks/mercadopago/route.ts`, `apps/web/lib/webhooks/mercadopago.ts`      |
| Webhook            | `GET/POST /api/webhooks/instagram` (maxDuration 25 s)                                                                                                                                                             | `apps/web/app/api/webhooks/instagram/route.ts`, `apps/web/lib/webhooks/instagram.ts`          |
| Job                | `runJob` (lock por `lock_key` + índice único parcial, `job_runs`)                                                                                                                                                 | `packages/integrations/src/jobs.ts`                                                           |
| Cron (web)         | `webhooks-retry` `*/15 * * * *`                                                                                                                                                                                   | `apps/web/vercel.json`, `apps/web/app/api/cron/webhooks-retry`                                |
| Cron (admin)       | `sessions-purge` `0 9 * * *` · `stock-alerts` `0 */2 * * *` · `customer-events` `30 14 * * *`                                                                                                                     | `apps/admin/vercel.json`, `apps/admin/app/api/cron/*`                                         |
| Health             | `/api/health` (liveness) y `/api/ready` (`dbHealth`) en ambas apps                                                                                                                                                | `apps/*/app/api/{health,ready}`, `packages/db/src/index.ts`                                   |
| Importador         | CSV/XLSX → 6 entidades, dry-run/apply/strict, `import_batches`/`import_rows`, reportes `.md`, 7 mapeos de ejemplo                                                                                                 | `packages/db/scripts/import-sheets.ts`, `packages/db/scripts/import/**`, `packages/db/import` |
| DB                 | 21 migraciones (18 publicadas en `RELEASED` + 0014, 0015 y 0041 pendientes), `_post_migrate.sql`, migrate/seed/seed-demo/reset/codegen                                                                            | `packages/db/migrations`, `packages/db/scripts`                                               |
| Scripts operativos | `deploy`, `rollback`, `backup`, `restore-drill`, `smoke`, `smoke-e2e` (nuevo), `check-env`, `check-secrets`, `check-migrations`, `check-grants`, `release-migrations`, `vercel-setup`, `db-integrity.sql` (nuevo) | `scripts/`                                                                                    |
| CI                 | Postgres 17, install congelado, secretos, migraciones, grants (nuevo), check-env (nuevo), formato, lint, typecheck, tests, audit, build, E2E                                                                      | `.github/workflows/ci.yml`                                                                    |
| Smoke              | `@smoke` web (11) y admin (7), solo lectura                                                                                                                                                                       | `apps/*/e2e/smoke.spec.ts`, `pnpm smoke:e2e`                                                  |

---

## 2. Matriz de cobertura

Evidencia: `T:` test automatizado (archivo › caso) · `V:` verificación en vivo contra servidores/DB locales (salida registrada durante la auditoría).
Archivos de test nuevos: `IA` = `packages/integrations/test/audit_infra.test.ts`, `DA` = `packages/db/test/audit_infra.test.ts`, `WA` = `apps/web/test/webhook-audit-infra.test.ts`.

### 2.1 Webhook Mercado Pago

| Caso                                                                                                     | Estado  | Evidencia                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| Firma válida                                                                                             | PASS    | T: `webhook-mercadopago.test.ts` › dos entregas…                                                                       |
| Firma inválida / ausente                                                                                 | PASS    | T: `webhook-mercadopago.test.ts` › firma inválida → 401; sin registros                                                 |
| `ts` manipulado, `data.id` o `x-request-id` distintos a los firmados                                     | PASS    | T: WA › ts manipulado… → 401 sin registrar                                                                             |
| Payload inválido (no JSON, sin `data.id`)                                                                | PASS    | T: WA › payload inválido; V: `curl` body `garbage{` → 200 ignored                                                      |
| `type ≠ payment`                                                                                         | PASS    | T: `webhook-mercadopago.test.ts` › merchant_order → ignored                                                            |
| `data.id` no numérico                                                                                    | PASS    | T: WA; V: `data.id=ABC-123` → evento `ignored` "data.id inválido", sin consultar MP                                    |
| `data.id` inexistente en MP (404)                                                                        | PASS    | V: evento `failed` + 500 (MP reintenta); T: IA › 404 → `MercadoPagoApiError` sin reintentos, **sin abrir el breaker**  |
| `external_reference` inválido / pedido inexistente                                                       | PASS    | T: `webhook-mercadopago.test.ts` › ignored                                                                             |
| Pedido **cancelado** con pago aprobado                                                                   | PASS¹   | T: DA › pedido cancelado; WA › 200 processed, alerta `payment_on_cancelled_order`, sin venta ni reintentos             |
| Pedido **ya pagado** + otro pago (duplicado del cliente)                                                 | PASS¹   | T: DA › needs_refund + alerta, 1 pago, 1 venta                                                                         |
| Duplicado exacto                                                                                         | PASS    | T: `webhook-mercadopago.test.ts` › 1 venta/1 pago/1 evento                                                             |
| `payment.created` + `payment.updated`                                                                    | PASS    | T: `webhook-mercadopago.test.ts` › 2 eventos, 1 pago                                                                   |
| Fuera de orden: approved antes que pending/rejected                                                      | PASS    | T: DA › no revierten la venta                                                                                          |
| Fuera de orden: refunded antes que approved                                                              | PASS    | T: DA y WA › pago+reembolso, approved posterior no crea 2ª venta                                                       |
| pending → approved → refunded (reembolso idempotente)                                                    | PASS    | T: DA                                                                                                                  |
| **Monto distinto al del pedido** (menor / mayor)                                                         | PASS¹   | T: DA y WA › menor = parcial sin venta + `payment_mismatch`; mayor = se registra el saldo, venta, alerta con excedente |
| Reintento tras fallo: 500 → `failed` → cron con backoff                                                  | PASS    | T: `webhook-mercadopago.test.ts` › backoff; WA › tope 8 intentos y ventana 48 h                                        |
| Evento huérfano en `processing` (función muerta)                                                         | PASS¹   | T: WA › reentrega y cron lo retoman si > 10 min; reciente = duplicado                                                  |
| Concurrencia: dos entregas simultáneas                                                                   | PASS    | T: WA › `Promise.all` → 1 venta, 1 pago, 1 evento, 1 consulta a MP                                                     |
| Producción sin `MERCADOPAGO_WEBHOOK_SECRET` → rechaza                                                    | PASS    | T: WA › 500 "webhook no configurado", nada registrado                                                                  |
| Verificación SQL de `webhook_events`, `payments`, `sales`, `inventory_movements`, `loyalty_transactions` | PASS    | T: DA › monto exacto (stock 46, 1 movimiento SALE, 12 puntos)                                                          |
| Pago real de sandbox / botón "Simular" del panel                                                         | BLOCKED | Requiere `MERCADOPAGO_ACCESS_TOKEN` TEST + URL pública                                                                 |

¹ PASS tras corrección de esta auditoría (ver §4).

### 2.2 Webhook Instagram

| Caso                                                          | Estado  | Evidencia                                                                                       |
| ------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| Challenge correcto / incorrecto                               | PASS    | T: `webhook-instagram.test.ts`; V: 200 `12345` / 403                                            |
| Firma válida / inválida / ausente / cuerpo alterado           | PASS    | T: `webhook-instagram.test.ts`; WA › cuerpo alterado 401                                        |
| JSON inválido                                                 | PASS    | V: 400 "JSON inválido"                                                                          |
| Eventos `messaging` (fixture con forma oficial), echo, read   | PASS    | T: `webhook-instagram.test.ts`, `instagram.test.ts`                                             |
| Mensaje sin texto (adjunto)                                   | PASS    | T: WA › guarda attachments, no responde                                                         |
| Elementos malformados (`null`, número) en `messaging`/`entry` | PASS¹   | T: IA › antes lanzaba `TypeError` → 500 → Meta reintentaba sin fin                              |
| Dedupe por `mid`                                              | PASS    | T: `webhook-instagram.test.ts` › reentrega no duplica                                           |
| Bot flag on/off                                               | PASS    | T: `webhook-instagram.test.ts`                                                                  |
| Envío fallido → evento `failed`, entrante guardado, 200       | PASS    | T: `webhook-instagram.test.ts`                                                                  |
| Evento huérfano en `processing`                               | PASS¹   | T: WA                                                                                           |
| Lead creado / reutilizado                                     | PASS    | T: `webhook-instagram.test.ts`                                                                  |
| IA con flag on sin `ANTHROPIC_API_KEY` → reglas               | PASS    | T: WA (end-to-end) e IA (no llama al SDK)                                                       |
| Input vacío / espacios / emoji / larguísimo                   | PASS¹   | T: IA y WA › respuesta ≤ 1000 bytes con enlace (antes `truncateUtf8` podía devolver 1002 bytes) |
| Respuesta del modelo fuera de formato / SDK lanza / historial | PASS    | T: IA › sin bloques de texto → reglas; 401 → reglas; ≤ 6 mensajes de historial, entrada ≤ 2000  |
| Meta real (verificación del webhook, Send API, ventana 24 h)  | BLOCKED | Requiere app de Meta, `META_APP_SECRET`, `INSTAGRAM_PAGE_ACCESS_TOKEN`                          |
| Modelo `claude-sonnet-5` responde en formato esperado         | BLOCKED | Requiere `ANTHROPIC_API_KEY`                                                                    |

### 2.3 Adaptadores

| Caso                                                                                   | Estado  | Evidencia                                                                        |
| -------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `fetchWithResilience`: timeout, reintento idempotente 5xx, error de red                | PASS    | T: IA                                                                            |
| No reintenta operaciones no idempotentes                                               | PASS    | T: IA; `instagram.test.ts` › Send API                                            |
| Breaker abre con 5 fallos transitorios, aísla por host, cierra tras cooldown           | PASS    | T: IA                                                                            |
| Breaker **no** abre con 4xx                                                            | PASS¹   | T: IA (antes 5 × 404 abrían 30 s el circuito de toda la API de MP)               |
| MP preferencia / pago / reembolso / Point / QR: shapes                                 | PASS    | T: `mercadopago.test.ts`                                                         |
| MP errores 4xx/5xx/no-JSON, montos raros, validaciones sin red                         | PASS¹   | T: IA (el mensaje de error perdía el cuerpo no JSON)                             |
| Resend: nunca lanza (no JSON, red, 429 tras reintentos), `Idempotency-Key`             | PASS    | T: IA, `email.test.ts`                                                           |
| HTML escapado con XSS en producto/cliente/folio/notas; URLs `javascript:`/`data:`      | PASS    | T: IA                                                                            |
| Storage local: traversal, nombre raro, tipo inválido, > 5 MB, claves inválidas         | PASS    | T: IA, `storage.test.ts`                                                         |
| Storage Supabase (mock): POST, 4xx, DELETE 404, sin credenciales                       | PASS    | T: `storage.test.ts`                                                             |
| Logger: claves sensibles (profundidad, arrays, errores), Bearer, tokens, Luhn          | PASS    | T: IA. Política: el email **no** se redacta automáticamente (se usa `maskEmail`) |
| `runJob`: lock, simultáneos, liberación tras fallo, error en `job_runs`, lock huérfano | PASS    | T: `webhook-mercadopago.test.ts`, WA                                             |
| Resend / Supabase Storage / Sentry reales                                              | BLOCKED | Requiere `RESEND_API_KEY`+dominio, `SUPABASE_SERVICE_ROLE_KEY`, DSN              |

### 2.4 Crons

| Caso                                                         | Estado | Evidencia                                                                                       |
| ------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| 401 sin secreto / secreto incorrecto / esquema Basic (los 4) | PASS   | V: `curl` × 4 rutas; smoke admin › crons 401                                                    |
| 200 con secreto, dos corridas seguidas (idempotencia)        | PASS   | V: 4 rutas × 2 → 200; `stock-alerts` 1ª: `ingredient_low: 16`, 2ª: 0 (no duplica)               |
| `job_runs` registrado                                        | PASS   | V: `select job_name, status, count(*) from job_runs` → 12 `succeeded`                           |
| `vercel.json` ↔ rutas existentes                             | PASS   | V: 4/4 rutas del `vercel.json` tienen `route.ts`; ninguna ruta sin programación                 |
| Lock huérfano en crons sin `runJob` (`customer-events`)      | PASS¹  | T: DA › trigger 0015 (antes: 409 para siempre tras un proceso muerto)                           |
| `CRON_SECRET` requerido y consistente                        | FAIL²  | V: con 15 caracteres `sessions-purge`=401, `stock-alerts`=200, `customer-events`=200 (ver P2-6) |

² Mitigado: `check-env` exige ≥ 16 caracteres y CI ya usa uno válido. El código de las dos rutas queda fuera del alcance.

### 2.5 Importador Sheets

| Caso                                                               | Estado  | Evidencia                                                                                    |
| ------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| BOM, `;`, comillas RFC 4180, filas vacías                          | PASS    | V: CSV propio; T: `import.test.ts`, DA                                                       |
| Decimales con coma y miles con punto (`$ 1.250,50`), kg/l → g/ml   | PASS    | V + T: DA (125050 ¢ / 5000 g)                                                                |
| Teléfonos `(664) 123-4567`, `+52 664…`, `52 1 664…`                | PASS    | V: normalizados; duplicado del mismo número omitido                                          |
| Fechas `dd/mm/aaaa`, `dd/mm/aa`, inválida `31/02/1991`             | PASS    | V: la inválida → error por fila con motivo                                                   |
| Encabezados en mayúsculas                                          | PASS    | V + T                                                                                        |
| Encabezados **sin acento** / espacios extra                        | PASS¹   | T: DA (antes `Categoria` abortaba y en modo largo `PRODUCTO` leía celdas vacías)             |
| Columna faltante, mapeo con transformación desconocida             | PASS    | V: error claro con encabezados disponibles                                                   |
| Duplicados similares (`Mantequilla sin sal` ~ `Mantequilla`, 75 %) | PASS    | V: `skipped` con motivo, no fusiona                                                          |
| Receta con insumo inexistente; `--strict` revierte todo            | PASS    | V: `FALLÓ`, 0 recetas creadas                                                                |
| Ventas históricas: no mueven inventario ni puntos; idempotentes    | PASS    | V: stock 14150 → 14150, movimientos 1299 → 1299, puntos 7777 → 7777; T: `import.test.ts`, DA |
| Dry-run no escribe tablas de negocio                               | PASS    | V: conteos iguales; solo `import_batches`/`import_rows`                                      |
| Apply idempotente                                                  | PASS¹   | T: DA (precio con "Vigente desde" anterior se duplicaba en cada `--apply`)                   |
| Producción exige `--yes-production`; reportes `.md` generados      | PASS    | V                                                                                            |
| Mapeos de ejemplo válidos                                          | PASS    | T: `import.test.ts` usa los 7                                                                |
| Export real de la hoja de la panadería                             | BLOCKED | Requiere el archivo del cliente (`docs/GO_LIVE.md`)                                          |

### 2.6 Base de datos

| Caso                                                                                      | Estado | Evidencia                                                             |
| ----------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------- |
| RLS + `pdp_app_all` en todas las tablas                                                   | PASS   | T: DA, `security_grants.test.ts`                                      |
| anon/authenticated/PUBLIC sin tablas, **vistas**, secuencias ni funciones (incl. pg_trgm) | PASS   | T: DA; `check-grants.sh` ampliado                                     |
| Funciones nuevas no nacen ejecutables por PUBLIC/anon                                     | PASS¹  | T: DA (hueco residual de 0080, ver §4.1)                              |
| Triggers append-only (`inventory_movements`, `loyalty_transactions`, `domain_events`)     | PASS   | T: DA                                                                 |
| Integridad con seed + demo (374 pedidos) e importaciones                                  | PASS   | V: `scripts/db-integrity.sql` → todos los bloques en 0 filas          |
| Invariantes tras venta con cupón, anulación y reembolso parcial                           | PASS   | T: DA                                                                 |
| `rebuild_inventory_levels` repara una deriva inducida                                     | PASS   | T: DA (999 → 48)                                                      |
| Checksums aplicados = archivos = `RELEASED`                                               | PASS   | T: DA; V: 17/17 ok                                                    |
| `check-migrations.sh` falla con migración publicada modificada / versión duplicada        | PASS   | V: copia alterada → exit 1 en ambos casos                             |
| `db:reset` rechaza host remoto y `APP_ENV=production`                                     | PASS   | T: DA (exit 2 sin conectarse)                                         |
| Seed idempotente (dos veces)                                                              | PASS   | T: DA; V: conteos iguales en dev                                      |
| Codegen = esquema                                                                         | PASS   | T: DA (regenera y compara byte a byte)                                |
| `explain analyze` de 14 consultas pesadas                                                 | PASS   | V: todas < 40 ms con 374 ventas; ver P3-4 sobre `report_daily_series` |

### 2.7 Scripts, build y CI

| Caso                                                                                                                                                                          | Estado | Evidencia                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `bash -n` de todos los `.sh`                                                                                                                                                  | PASS   | V                                                                                                                |
| `deploy.sh` (revisión lógica): limpio → verify con entorno local → carga `.env.<env>` → guarda localhost → check-env → backup → migrate → check-grants → deploy → smoke → tag | PASS   | Revisión; ver P2-7                                                                                               |
| `rollback.sh`                                                                                                                                                                 | PASS   | Revisión (`vercel rollback`); ejecución real BLOCKED (Vercel)                                                    |
| `backup.sh` + `restore-drill.sh`                                                                                                                                              | PASS¹  | V: dump 972 K con 3 extensiones; drill OK en 0–1 s, 63/63 tablas; dump corrupto → exit 1 sin dejar base huérfana |
| `smoke.sh`                                                                                                                                                                    | PASS   | V: 7/7                                                                                                           |
| `check-env.mjs` (15 combinaciones)                                                                                                                                            | PASS¹  | V: exit codes correctos; ver bug §4                                                                              |
| `check-secrets.sh` detecta secreto falso versionado                                                                                                                           | PASS   | V: `APP_USR-…` en archivo staged → exit 1 (limitación: archivos no versionados no se escanean)                   |
| `release-migrations.sh --check`, `vercel-setup.sh` (`bash -n`)                                                                                                                | PASS   | V                                                                                                                |
| `pnpm audit --prod`, versiones exactas, lockfile congelado                                                                                                                    | PASS   | V: 0 vulnerabilidades; 0 rangos `^`/`~`                                                                          |
| `next.config`: cabeceras, Sentry solo con token                                                                                                                               | PASS   | V: smoke verifica `nosniff`, `DENY`, `noindex` (admin), sin `x-powered-by`                                       |
| Sentry sin DSN no inicializa / con DSN mock inicializa                                                                                                                        | PASS   | V: script con transporte falso                                                                                   |
| Sentry `beforeSend` redacta                                                                                                                                                   | FAIL²  | V: `query_string` y `extra` salen sin redactar (P2-5)                                                            |
| `turbo.json` `globalEnv` / `.env.example` vs `process.env.*`                                                                                                                  | FAIL²  | V: faltan `BUSINESS_TZ`, `E2E_WEB_URL` (P3-1)                                                                    |
| CI: Node 22 (`.nvmrc`), caché pnpm, Postgres 17, E2E un worker                                                                                                                | PASS   | Revisión; agregados `check-grants` y `check-env`, `CRON_SECRET` válido                                           |

### 2.8 Health y smoke

| Caso                                                                        | Estado  | Evidencia                                                                      |
| --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `/api/health` 200 en ambas apps (también con DB caída)                      | PASS    | V                                                                              |
| `/api/ready` 200 con DB arriba (`migrations: 19`; 21 tras el último rebase) | PASS    | V                                                                              |
| `/api/ready` 503 JSON con DB caída                                          | PASS¹   | V: `{"ok":false,…,"error":"ECONNREFUSED"}` (antes `"error":""`)                |
| Smoke E2E web (11) y admin (7, con login)                                   | PASS    | V: `pnpm smoke:e2e -- http://localhost:3115 http://localhost:3116` → 18 passed |
| Smoke contra staging/producción                                             | BLOCKED | Correr `pnpm smoke:e2e -- <urls>` tras el próximo deploy                       |

---

## 3. Problemas encontrados (P0–P3)

No se encontró ningún P0 nuevo (el P0 de privilegios en Supabase ya lo había corregido `main` con 0080).

| Id   | Sev | Problema                                                                                                                                                              | Estado                                 |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| P1-1 | P1  | Mercado Pago: monto distinto, pedido cancelado o ya pagado no se conciliaban (pago parcial silencioso o `failed` × 8 sin alerta; dinero cobrado sin rastro)           | Corregido                              |
| P1-2 | P1  | Eventos de webhook atorados en `processing` nunca se reintentaban; el `GET` de pago (10 s × 3 + backoff) podía superar `maxDuration` 20 s y dejarlos así              | Corregido                              |
| P1-3 | P1  | Respaldos lógicos no restaurables en una base nueva (`--schema=public` omite extensiones: 155 errores, faltan 63 de 63 tablas con `citext`)                           | Corregido                              |
| P1-4 | P1  | Hueco residual de 0080: funciones nuevas nacen ejecutables por PUBLIC/anon hasta `_post_migrate`; `check-grants` no veía vistas (saltan RLS) ni secuencias            | Corregido                              |
| P2-1 | P2  | Circuit breaker se abría con 4xx: 5 notificaciones simuladas (404) cortaban 30 s todas las llamadas a MP                                                              | Corregido                              |
| P2-2 | P2  | `check-env` en producción rellenaba huecos con el `.env` local; no validaba `CRON_SECRET` corto, integraciones a medias ni https; staging sin exigir SSL              | Corregido                              |
| P2-3 | P2  | Lock huérfano en `customer-events` (sin `runJob`) dejaba el cron en 409 para siempre                                                                                  | Corregido                              |
| P2-4 | P2  | Importador no idempotente con "Vigente desde" anterior; encabezados sin acento abortaban; en modo largo `PRODUCTO` leía celdas vacías                                 | Corregido                              |
| P2-5 | P2  | Sentry `scrubEvent` no redacta `request.query_string`, `extra`, `contexts` ni breadcrumbs                                                                             | Documentado                            |
| P2-6 | P2  | `stock-alerts`/`customer-events` autentican con `===` propio (sin longitud mínima, no tiempo constante) e inconsistente con `isCronAuthorized`                        | Documentado (mitigado por `check-env`) |
| P2-7 | P2  | `deploy.sh`: el smoke usa la URL del deployment (puede devolver 401 con Deployment Protection) y `vercel deploy 2>/dev/null` oculta el motivo de un fallo             | Documentado                            |
| P2-8 | P2  | Instagram: si falla el envío la ruta responde 200 (correcto para Meta) pero nadie reintenta los eventos `failed` de `meta` (el cron solo toma Mercado Pago)           | Documentado                            |
| P3-1 | P3  | `BUSINESS_TZ` (`apps/admin/lib/format.ts`) y `E2E_WEB_URL` no están en `turbo.json`/`.env.example`; en modo estricto de turbo `pnpm test:e2e` no recibe `E2E_WEB_URL` | Documentado                            |
| P3-2 | P3  | `truncateUtf8` podía devolver 1002 bytes (elipsis = 3 bytes) → Send API rechaza; parser de IG lanzaba con elementos `null`                                            | Corregido                              |
| P3-3 | P3  | `dbHealth` devolvía `error: ""` con la base caída; `MercadoPagoApiError` perdía cuerpos no JSON; `restore-drill` dejaba la base temporal si fallaba                   | Corregido                              |
| P3-4 | P3  | `report_daily_series`: subconsultas correlacionadas por día (5 seq scans × 61 días; 39 ms hoy); crecerá lineal con ventas × días                                      | Documentado                            |
| P3-5 | P3  | `migrate.ts` aplica migraciones con número menor a la última aplicada sin aviso (0015 correrá después de 0080 en producción; es segura, pero no hay guarda)           | Documentado                            |
| P3-6 | P3  | `check-secrets.sh` solo escanea archivos versionados y omite por completo cualquier test marcado `secret-scan: fixtures`                                              | Documentado                            |

---

## 4. Bugs corregidos (causa raíz → fix → test)

### 4.1 Privilegios: hueco residual sobre la solución de `main` (P1-4)

- **Causa raíz**: `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE … FROM public` (0009 y 0080) no puede quitar el EXECUTE que PUBLIC recibe por omisión: los defaults por esquema se **suman** a los globales. Prueba en base limpia con exactamente los defaults de 0080: `create function f()` → `has_function_privilege('anon', f, 'execute') = true`. `_post_migrate.sql` lo cierra al final de cada `db:migrate`, pero queda expuesto (a) entre el commit de cada migración y el post, y (b) todo lo creado fuera de `db:migrate` (SQL Editor) hasta el siguiente deploy. Además `check-grants.sh` y `security_grants.test.ts` solo consultaban `pg_tables`: **una vista concedida a anon pasaba el chequeo** (demostrado con `grant select on catalog_products to anon` → el script de main dijo "Sin exposición"), y las vistas se ejecutan con permisos del dueño, sin RLS.
- **Fix**: `0015_audit_infra.sql` §4 fija el default **global** (`alter default privileges revoke execute on functions from public`, más la variante `for role postgres`); no repite nada de 0080. `scripts/check-grants.sh` ahora falla con tablas/vistas/vistas materializadas/tablas foráneas (select/insert/update/delete), secuencias y funciones de negocio; avisa sin bloquear para funciones de extensiones y USAGE del esquema (en Supabase pueden ser de `supabase_admin`). `scripts/db-integrity.sql` bloque 9 con los mismos contadores. CI corre `check-grants.sh`.
- **Tests** (DA): función nueva no ejecutable por PUBLIC/anon sin `_post_migrate`; sin exposición en tablas/vistas/secuencias/funciones incluidas las de pg_trgm; `check-grants.sh` detecta una vista y una secuencia expuestas.
- Hallazgos para `main` sobre extensiones: en local las funciones de pg_trgm/citext **sí** quedan cerradas (`_post_migrate` revoca `all functions in schema public`, que incluye miembros de extensiones). El chequeo de `main` las excluía, así que una regresión no se habría visto; ahora aparecen como aviso. En Supabase conviene confirmar con `bash scripts/check-grants.sh` (bloque de avisos) si las extensiones viven en `public` o en `extensions`.

### 4.2 Conciliación de montos y estados de Mercado Pago (P1-1)

- **Causa raíz**: `apply_mercadopago_payment` pasaba el monto de MP directo a `record_payment`. Menor al saldo → pedido `partial` sin ninguna alerta. Mayor → `record_payment` lanza "excede el total" → evento `failed`, 8 reintentos inútiles, cobro sin registrar. Pedido cancelado → lanza "Pedido cancelado" → igual. Segundo pago sobre un pedido pagado → lanza → igual.
- **Fix** (0015 §1): calcula el saldo (`total − paid`) bajo `FOR UPDATE` del pedido; con diferencia registra lo que corresponde (el saldo si sobra, lo acreditado si falta), guarda `mp_amount_cents/expected_cents` en `payments.metadata` y crea `notifications` `payment_mismatch` (severidad error, deduplicada); pedido cancelado o ya pagado → no registra y deja `payment_on_cancelled_order` / `payment_mismatch` con instrucción de reembolso. El evento queda `processed` (no reintenta). Una transición pending → approved sobre un pedido cancelado también alerta.
- **Tests**: DA (9 casos de `apply_mercadopago_payment`), WA (menor, mayor, cancelado end-to-end por la ruta). Runbook en `MONITORING.md` §3.

### 4.3 Eventos huérfanos y presupuesto de tiempo del webhook (P1-2)

- **Causa raíz**: el claim atómico pasa el evento a `processing`; si la función muere (timeout, OOM, deploy), la ruta respondía `duplicate` para siempre y `webhooks-retry` solo tomaba `received/failed`. `fetchMercadoPagoPayment` usaba 10 s × 3 intentos + backoff (> 30 s) con `maxDuration = 20`, así que una API lenta producía exactamente ese estado: pago aprobado, pedido pendiente.
- **Fix**: `processMercadoPagoEvent` reclama también `processing` con `last_attempt_at` > 10 min; `retryPendingMercadoPagoEvents` los incluye; la ruta procesa y solo responde duplicado si el claim falla. GET de pago: 5 s × 2 intentos (≈ 10.5 s peor caso). Instagram: `recordEvent` retoma `received/processing` huérfanos. Índice parcial `webhook_events_processing_idx`.
- **Tests**: WA › huérfano reciente = duplicado, viejo = lo retoman cron y reentrega, venta única; IA › 1 reintento en 5xx.

### 4.4 Respaldos restaurables (P1-3)

- **Causa raíz**: `pg_dump --schema=public` no incluye `CREATE EXTENSION`; en una base nueva `citext` no existe y todas las tablas que lo usan fallan. El drill original terminaba con `pg_restore` exit 1, sin línea en el log y dejando `pdp_restore_drill_<ts>` huérfana; el procedimiento B de `BACKUP_RESTORE.md` también habría fallado.
- **Fix**: `backup.sh` agrega `--extension=<cada extensión de pg_extension>` y rechaza un dump sin extensiones; `restore-drill.sh` crea las extensiones (compatible con dumps viejos), falla ante cualquier error real de `pg_restore` o si las tablas restauradas ≠ las del dump, avisa si faltan migraciones, borra la base con `trap` y registra `OK/FAIL`. Documentado en `BACKUP_RESTORE.md` (incluye volver a revocar EXECUTE tras `--no-privileges`).
- **Evidencia**: dump viejo y nuevo → OK 63/63 tablas; dump truncado → exit 1, `FAIL` en el log, 0 bases huérfanas. RTO local medido: 0–1 s.

### 4.5 Resto

| Bug                                        | Causa raíz → fix                                                                                                                                                                                                    | Test / evidencia                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Breaker con 4xx (P2-1)                     | `recordFailure` para toda respuesta no-ok → solo cuenta si es transitoria (`shouldRetry`)                                                                                                                           | IA › 8 × 404 sin abrir                           |
| `check-env` (P2-2)                         | Leía `.env` local para cualquier entorno → solo en development; +`CRON_SECRET` ≥ 16, pares obligatorios (MP token↔secret, IG token→app secret/verify, Resend→`EMAIL_FROM`, storage supabase), https, SSL en staging | V: 15 combinaciones con exit code                |
| Lock huérfano en crons sin `runJob` (P2-3) | Solo `runJob`/`stock-alerts` liberaban → trigger `BEFORE INSERT` en `job_runs` libera `running` > 15 min del mismo `lock_key`                                                                                       | DA, WA                                           |
| Importador no idempotente (P2-4)           | Comparaba contra el precio más reciente por `valid_from` → compara también contra el historial (precio, contenido, día local)                                                                                       | DA › 3 `--apply` → 1 precio nuevo (rojo sin fix) |
| Encabezados sin acento (P2-4)              | `toLowerCase()` exacto y `mr.raw[items.product]` literal → `normHeader` (sin acentos, espacios colapsados; conserva ñ) en validación, mapeo y modos ancho/largo                                                     | DA › productos, largo y ancho (rojo sin fix)     |
| `truncateUtf8` / parser IG (P3-2)          | Reservaba 1 byte para "…" (son 3); `ev.sender` sobre `null`                                                                                                                                                         | IA                                               |
| `dbHealth` / error MP / drill (P3-3)       | `AggregateError` de pg con `message` vacío → usa código/causa; cuerpo no JSON se conserva en el mensaje                                                                                                             | V: `ECONNREFUSED`; IA                            |

---

## 5. Tests creados

| Archivo                                          | Casos | Qué cubre                                                                                                                                               |
| ------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/integrations/test/audit_infra.test.ts` |    29 | resiliencia HTTP, errores MP, XSS en emails, `sendEmail` nunca lanza, storage, redacción del logger, payloads e IA de IG                                |
| `packages/db/test/audit_infra.test.ts`           |    23 | RLS/grants/vistas/secuencias/funciones, `check-grants.sh`, append-only, conciliación MP, locks, integridad, importador, checksums, reset, seed, codegen |
| `apps/web/test/webhook-audit-infra.test.ts`      |    17 | MP (producción sin secreto, firmas, concurrencia, huérfanos, montos, cancelado, fuera de orden, tope), `runJob`, IG                                     |
| `apps/web/e2e/smoke.spec.ts`                     |    11 | `@smoke` web, solo lectura                                                                                                                              |
| `apps/admin/e2e/smoke.spec.ts`                   |     7 | `@smoke` admin, solo lectura (login si hay credenciales)                                                                                                |

Totales tras la auditoría (sobre `main` 138d448): `@pdp/integrations` 109 (79 al empezar + 1 de `main`) · `@pdp/db` 146 (105 al empezar + 18 de `main`) · `@pdp/web` 33 (antes 16) · smoke E2E 18. `pnpm typecheck`, `pnpm lint`, `pnpm format:check` y `pnpm build` en verde.

Scripts nuevos: `scripts/db-integrity.sql` (solo lectura; cómo interpretarlo en su encabezado y en `MONITORING.md` §3), `scripts/smoke-e2e.sh` (`pnpm smoke:e2e -- <web> <admin>`, sección en `DEPLOYMENT.md`).

---

## 6. BLOCKED y cómo desbloquearlo

| Qué                                                     | Credencial / acción exacta                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pago real de sandbox y conciliación end-to-end          | `MERCADOPAGO_ACCESS_TOKEN` TEST + `MERCADOPAGO_WEBHOOK_SECRET` en staging; pedido web con tarjeta `APRO`; verificar `db-integrity.sql` bloques 3 y 7c        |
| Monto distinto real / pago sobre pedido cancelado       | En staging: cancelar el pedido antes de pagar con la preferencia ya creada; confirmar la notificación `payment_on_cancelled_order`                           |
| Point / QR                                              | Terminal vinculada en modo PDV (`MERCADOPAGO_POINT_DEVICE_ID`), caja con `external_pos_id` (`MERCADOPAGO_QR_EXTERNAL_POS_ID`), cobro mínimo real + reembolso |
| Meta / Instagram                                        | App de Meta con `META_APP_SECRET`, `META_VERIFY_TOKEN`, `INSTAGRAM_PAGE_ACCESS_TOKEN`; "Verificar y guardar" del webhook; DM desde una cuenta tester         |
| IA del bot                                              | `ANTHROPIC_API_KEY` en staging y flag `instagram_ai_replies`; revisar 10 respuestas reales                                                                   |
| Resend                                                  | Dominio verificado + `RESEND_API_KEY` + `EMAIL_FROM`; enviar un comprobante a una casilla propia                                                             |
| Sentry                                                  | DSN por app; forzar un error en staging y revisar en el evento que no haya cookies, firmas, `query_string` sensible ni `extra` con tokens (P2-5)             |
| Supabase Storage                                        | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + bucket `product-images`; subir y borrar una imagen desde el admin                                             |
| Privilegios en Supabase (avisos de extensiones y USAGE) | `bash scripts/check-grants.sh "$MIGRATE_DATABASE_URL"` en staging y producción (solo lectura) con esta rama                                                  |
| Smoke y drill con datos de producción                   | `pnpm smoke:e2e -- https://elpandepaula.mx https://admin.elpandepaula.mx`; `bash scripts/backup.sh production` + `pnpm restore:drill`                        |
| Cron `*/15`                                             | Plan Vercel Pro o scheduler externo con `Authorization: Bearer $CRON_SECRET`                                                                                 |

---

## 7. Riesgos residuales

1. **0014, 0015 y 0041 correrán fuera de orden en producción** (después de 0080). En la base dev se aplicaron 0014/0041 después de 0015/0080 sin problemas y `check-grants` quedó limpio. Es aditiva e idempotente y se probó en ambos órdenes (base nueva: 0015 → 0080; base con 0080 ya aplicada, como producción: 0080 → 0015, `check-grants` limpio y funciones nuevas no ejecutables por anon), pero `migrate.ts` no tiene guarda para esto (P3-5). Tras desplegarla: `release-migrations.sh`.
2. **Alertas de conciliación dependen de que alguien lea `notifications`**: no hay aviso por email/WhatsApp todavía (acción externa de `MONITORING.md`).
3. **Eventos de Instagram `failed` no se reintentan** (P2-8): un cliente puede quedar sin respuesta automática; queda visible en `webhook_events` y en la bandeja del admin.
4. **Sentry puede enviar tokens** en `query_string`/`extra` (P2-5) en cuanto se cargue el DSN. Corregirlo antes de activar Sentry en producción: aplicar `redact()` de `@pdp/integrations` a `extra`, `contexts`, breadcrumbs y parámetros de la URL en `apps/*/lib/sentry-options.ts`.
5. **Autenticación de `stock-alerts`/`customer-events`** (P2-6): reproducción `CRON_SECRET=dev-cron-secret pnpm --filter @pdp/admin start` → `curl -H 'Authorization: Bearer dev-cron-secret' /api/cron/stock-alerts` = 200 y `/api/cron/sessions-purge` = 401. Fix sugerido: usar `isCronAuthorized` + `runJob` en ambas rutas.
6. **Smoke post-deploy con Deployment Protection** (P2-7): si se activa en Vercel, `smoke.sh` sobre la URL del deployment falla aunque la app esté sana; usar el dominio o un bypass token.
7. **Crecimiento de reportes** (P3-4): `report_daily_series` escala con ventas × días; revisar al superar ~50 k ventas (agregar `sales` por día local o un índice de expresión sobre `(sold_at at time zone tz)::date`).
8. **Credenciales reales**: todo lo marcado BLOCKED sigue sin probarse con los proveedores.

---

## 8. Health score del área (87/100)

| Área                                           | Peso | Puntos | Motivo del descuento                                                    |
| ---------------------------------------------- | ---: | -----: | ----------------------------------------------------------------------- |
| Webhook Mercado Pago                           |   20 |     17 | Sin prueba con sandbox real; Point/QR sin conciliar                     |
| Webhook Instagram                              |    8 |      6 | Eventos `failed` sin reintento; sin Meta real                           |
| Adaptadores (HTTP, MP, email, storage, logger) |   10 |      9 | Proveedores reales BLOCKED                                              |
| Crons y jobs                                   |   10 |      8 | Autenticación inconsistente en 2 rutas; `*/15` depende del plan         |
| Importador                                     |    8 |    7.5 | Falta el export real de la hoja                                         |
| Base de datos                                  |   15 |   13.5 | Guarda de orden de migraciones; escalabilidad de un reporte             |
| Scripts, backup y restauración                 |   10 |    8.5 | PITR pendiente; smoke de deploy vs Deployment Protection                |
| Build, CI y configuración                      |    9 |      8 | `scrubEvent` incompleto; variables fuera de `turbo.json`/`.env.example` |
| Health y smoke                                 |   10 |     10 | —                                                                       |
| **Total**                                      |  100 | **87** |                                                                         |
