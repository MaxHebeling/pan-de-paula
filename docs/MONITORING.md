# Monitoreo

Objetivo: enterarnos **antes que el cliente** de que algo falla, con una acción clara para cada alerta.
Tres capas: señales HTTP (¿responde?), errores de aplicación (Sentry/logs) y señales de negocio en la base
(¿se están aplicando los pagos?, ¿cuadra el stock?).

## 1. Salud HTTP

| Endpoint (en `apps/web` y `apps/admin`) | Qué comprueba                                                                    | Respuesta                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/health`                       | La función responde (liveness). No toca la base.                                 | `200 {ok:true, app, version: <sha7                               | dev>, time}` |
| `GET /api/ready`                        | Conexión a Postgres + `count(*)` de `schema_migrations` (`dbHealth()`), latencia | `200 {ok:true, db:{ok, latencyMs, migrations}}` · `503` si falla |

- `scripts/smoke.sh <web> <admin>` los consulta tras cada deploy (más `/`, `/menu`, `/login`).
- **Acción externa pendiente**: dar de alta un monitor de uptime (UptimeRobot, Better Stack o el monitor de
  Vercel) sobre `/api/ready` de **ambas** apps cada 1–5 min, con aviso por WhatsApp/email al operador y al dueño.
  Umbral: 2 fallos consecutivos = alerta.
- `version` debe coincidir con el sha del último tag `deploy-production-*` (ver `DEPLOYMENT.md`).

## 2. Errores de aplicación

### Sentry

- Inicializado en ambas apps (`apps/*/instrumentation.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`,
  `instrumentation-client.ts`, `global-error.tsx`). Opciones comunes en `apps/*/lib/sentry-options.ts`:
  `environment = APP_ENV`, `release = VERCEL_GIT_COMMIT_SHA`, `tracesSampleRate 0.1`, `sendDefaultPii false`,
  tag `app` (`web`/`admin`) y `beforeSend = scrubEvent`, que elimina cookies, `Authorization`, firmas de
  webhooks, campos `password/token/secret/card` e IP/email del usuario antes de enviar nada.
- Requiere `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (obligatoria en producción; sin DSN no envía) y, para
  source maps, `SENTRY_ORG/PROJECT/AUTH_TOKEN` en Vercel. Detalle en `INTEGRATIONS.md` §4.
- Alertas recomendadas en Sentry: nuevo issue en producción → inmediato; > 10 eventos/hora del mismo issue → escalar.

### Logs

- Convención del repo: `console.error("[módulo] contexto", err)` con datos suficientes para reproducir
  (id de pedido, proveedor, external_id); nunca secretos ni tokens. `dbErrorMessage()` traduce errores de
  Postgres para la UI sin filtrar detalles internos.
- Vercel: **Project → Logs** (runtime) filtrando por ruta (`/api/webhooks`, `/api/pos`) y nivel `error`;
  por CLI desde la carpeta de la app: `vercel logs <deployment-url>`.
- Supabase: **Logs → Postgres** para errores de la base, y **Database → Query Performance** para consultas lentas.
  **Advisors** (Security/Performance) se revisan tras cada migración publicada.

## 3. Señales de negocio en la base (SQL listo)

Ejecútalas en el SQL Editor de Supabase o con `psql "$DATABASE_URL"`. Cada una trae su umbral y su acción.

**Todo en uno (solo lectura):** `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-integrity.sql` corre las
invariantes de inventario, puntos, pagos/reembolsos, cupones, contadores de clientes, huérfanos, webhooks, jobs,
privilegios (tablas, **vistas**, secuencias, funciones) y migraciones. Sano = todos los bloques `[0 filas]` vacíos y los
`[resumen]` en 0. Correrlo una vez por semana y después de cada deploy con migraciones.

### Conciliación de Mercado Pago (monto distinto, pedido cancelado, pago duplicado)

```sql
select created_at, kind, title, body, entity_id as order_id from notifications
where kind in ('payment_mismatch','payment_on_cancelled_order') and read_at is null order by created_at desc;
```

Umbral: ≥ 1 → inmediato. `apply_mercadopago_payment` (0015) ya no aplica a ciegas lo que diga MP: si el monto
acreditado difiere del saldo del pedido, el pedido queda parcial (menor) o se registra solo el saldo (mayor); si el
pedido estaba cancelado o ya pagado, no se registra el pago. En todos los casos deja esta alerta con folio, id de pago y
montos. Acción: abrir el pago en el panel de MP → reembolsar la diferencia/duplicado o cobrar el faltante → marcar la
notificación como leída.

### Webhooks que fallaron o se atoraron (Mercado Pago / Meta)

```sql
select provider, external_id, event_type, status, attempts, last_attempt_at, last_error, received_at
from webhook_events
where status = 'failed' or (status in ('received','processing') and received_at < now() - interval '10 minutes')
order by received_at desc limit 50;
```

Umbral: `failed` con `attempts ≥ 3` o atorado > 1 h (el cron `webhooks-retry` ya reintentó) → runbook "MP aprueba
pero el pedido sigue pendiente" (`INCIDENT_RESPONSE.md`). `webhook_events` es idempotente por
`(provider, external_id)`: reprocesar es seguro.

### Pedidos web con pago pendiente demasiado tiempo

```sql
select o.folio, o.placed_at, o.total_cents, o.payment_status, o.status, o.customer_phone,
       (select count(*) from payments p where p.order_id = o.id) as payments
from orders o
where o.channel = 'web' and o.payment_status in ('pending','partial')
  and o.status not in ('cancelled','refunded') and o.placed_at < now() - interval '30 minutes'
order by o.placed_at;
```

Umbral: > 5 en un día o cualquiera > 2 h con pago aprobado en el panel de MP → runbook MP.

### Pagos rechazados hoy

```sql
select p.created_at, o.folio, p.provider, p.method, p.amount_cents, p.external_status
from payments p join orders o on o.id = p.order_id
where p.status = 'failed' and p.created_at > now() - interval '24 hours' order by p.created_at desc;
```

### Jobs (cron) fallidos o colgados

```sql
select job_name, status, started_at, finished_at, error
from job_runs
where (status = 'failed' and started_at > now() - interval '24 hours')
   or (status = 'running' and started_at < now() - interval '1 hour')
order by started_at desc;
```

Los crons están declarados en `apps/*/vercel.json` y protegidos por `Authorization: Bearer <CRON_SECRET>`
(`isCronAuthorized`); cada uno corre dentro de `runJob()` (`packages/integrations/src/jobs.ts`), que inserta el
`job_runs` `running` con `lock_key`, registra `succeeded/failed/skipped` y **libera solo** un lock colgado de más
de 15 min (lo marca `failed` con "lock expirado"):

| Job               | App   | Ruta                        | Frecuencia (`vercel.json`) | Qué hace                                                                                                                       |
| ----------------- | ----- | --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `webhooks-retry`  | web   | `/api/cron/webhooks-retry`  | cada 15 min                | Reprocesa notificaciones de Mercado Pago `received/failed` de las últimas 48 h (50 por corrida, backoff con `last_attempt_at`) |
| `sessions-purge`  | admin | `/api/cron/sessions-purge`  | diario 09:00 UTC           | Borra sesiones de staff expiradas/revocadas hace más de 30 días                                                                |
| `stock-alerts`    | admin | `/api/cron/stock-alerts`    | cada 2 h                   | Notificaciones de stock bajo/agotado e insumos críticos sin duplicar las abiertas                                              |
| `customer-events` | admin | `/api/cron/customer-events` | diario 14:30 UTC           | Cumpleaños, inactividad 30/60 días, aniversarios                                                                               |

`webhooks-retry` también retoma eventos atorados en `processing` más de 10 min (función que murió a medio camino).
Un `running` de más de 15 min en `job_runs` se libera automáticamente al insertar la siguiente corrida del mismo job
(trigger de 0015, cubre también a los crons que no usan `runJob`). **`CRON_SECRET` debe tener ≥ 16 caracteres**
(`check-env` lo exige): con menos, `webhooks-retry` y `sessions-purge` responden 401 siempre.

Forzar una corrida (por ejemplo tras caída de MP): `curl -H "Authorization: Bearer $CRON_SECRET" https://elpandepaula.mx/api/cron/webhooks-retry`.
Un `skipped` con `reason: locked` es normal si la corrida anterior sigue viva; un `running` de más de 15 min se
autolibera en la siguiente ejecución. **Vercel Hobby solo permite crons diarios**: el `*/15` exige plan Pro o un
scheduler externo que llame la ruta con el Bearer.

### Stock agotado o bajo

```sql
select name, on_hand, low_stock_threshold, level from stock_status
where track_stock and level <> 'ok' order by on_hand;
```

Acción: producción (`/produccion`). Además `notifications` recibe `low_stock`/`out_of_stock` automáticamente.

### Deriva de inventario (nivel materializado vs movimientos)

```sql
select l.product_id, p.name, l.on_hand, m.total
from inventory_levels l join products p on p.id = l.product_id
join (select product_id, sum(qty) as total from inventory_movements group by product_id) m using (product_id)
where l.on_hand <> m.total;
```

Debe devolver **cero filas**. Si no: `select rebuild_inventory_levels();` y abrir postmortem (algo escribió fuera de las funciones).

### Caja abierta demasiado tiempo

```sql
select id, opened_at, opened_by from register_sessions where status = 'open' and opened_at < now() - interval '20 hours';
```

### Intentos de login fallidos (fuerza bruta)

```sql
select ip, count(*) from login_attempts
where success = false and created_at > now() - interval '15 minutes'
group by ip having count(*) >= 20 order by 2 desc;
```

El sistema ya bloquea (30 intentos por IP / 15 min; 5 fallos por cuenta → 15 min). Si aparece una IP, bloquéala en Vercel (Firewall).

### Importaciones fallidas

```sql
select id, entity, file_name, status, total_rows, error_rows, created_at from import_batches
where status = 'failed' or (status = 'pending' and created_at < now() - interval '1 hour') order by created_at desc;
```

### Notificaciones internas sin atender

```sql
select kind, severity, count(*) from notifications where read_at is null and severity in ('warning','error') group by 1, 2;
```

### Migraciones pendientes en el ambiente

```bash
pnpm --filter @pdp/db run migrate:status   # con DATABASE_URL del ambiente; debe decir "0 pendiente(s)"
```

## 4. Resumen de alertas accionables

| Señal                                                      | Umbral            | Canal            | Acción                                                       |
| ---------------------------------------------------------- | ----------------- | ---------------- | ------------------------------------------------------------ |
| `/api/ready` 503 (cualquiera de las apps)                  | 2 fallos seguidos | WhatsApp+email   | Runbook "No se puede vender en POS" / `ROLLBACK.md`          |
| Sentry: issue nuevo en producción                          | 1                 | email/Slack      | Triage en < 1 h                                              |
| `webhook_events` failed                                    | ≥ 1 / hora        | email            | Runbook MP                                                   |
| `payment_mismatch` / `payment_on_cancelled_order` sin leer | ≥ 1               | email + CRM      | Conciliar en el panel de MP (reembolso/cobro)                |
| `check-grants.sh` / bloque 9 de `db-integrity.sql` ≠ 0     | ≥ 1               | inmediato        | `pnpm db:migrate` (ejecuta `_post_migrate.sql`) + postmortem |
| Pedido web pendiente con pago aprobado                     | > 30 min          | email            | Runbook MP                                                   |
| `job_runs` failed o running > 1 h                          | ≥ 1               | email            | Revisar log del job, marcar failed                           |
| Deriva de inventario                                       | > 0 filas         | email            | `rebuild_inventory_levels()` + postmortem                    |
| Stock agotado de producto activo                           | ≥ 1               | notificación CRM | Producción                                                   |
| Respaldo diario ausente                                    | > 26 h            | email            | `BACKUP_RESTORE.md`                                          |
| Uso de pooler Supabase > 80 %                              | 5 min             | Supabase         | Revisar `max` del pool / fugas                               |

Hasta que exista automatización de alertas (acción externa), esta lista se revisa **a diario** desde el
dashboard del CRM y una vez por semana con las consultas SQL.
