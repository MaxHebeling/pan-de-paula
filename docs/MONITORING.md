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

- Estado en el repo: `@sentry/nextjs` está declarado en `apps/web` y `apps/admin`, y las variables
  `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG/PROJECT/AUTH_TOKEN` existen en `.env.example`,
  `turbo.json` y `check-env.mjs` (obligatoria en producción). **La inicialización todavía no está en el
  código** (no hay `instrumentation.ts` ni `withSentryConfig`): es una acción pendiente del módulo de
  integraciones antes del go-live. Al hacerlo: `release = VERCEL_GIT_COMMIT_SHA`, `environment = APP_ENV`,
  `tracesSampleRate` bajo (0.1) y sin PII (no enviar teléfonos/emails de clientes).
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

### Webhooks que fallaron o se atoraron (Mercado Pago / Meta)

```sql
select provider, external_id, event_type, status, attempts, last_error, received_at
from webhook_events
where status = 'failed' or (status in ('received','processing') and received_at < now() - interval '10 minutes')
order by received_at desc limit 50;
```

Umbral: ≥ 1 en la última hora → revisar. Acción: runbook "MP aprueba pero el pedido sigue pendiente"
(`INCIDENT_RESPONSE.md`). `webhook_events` es idempotente por `(provider, external_id)`: reprocesar es seguro.

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

Nota: la tabla y el índice único de `lock_key` existen; las rutas `/api/cron/*` (protegidas por `CRON_SECRET`,
ya en la lista pública de `apps/admin/proxy.ts`) se implementan en su módulo. Cada job debe insertar en
`job_runs` al iniciar y cerrar con `succeeded/failed`. Un `running` de más de 1 h es un job muerto: márcalo
`failed` para liberar el lock.

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

| Señal                                     | Umbral            | Canal            | Acción                                              |
| ----------------------------------------- | ----------------- | ---------------- | --------------------------------------------------- |
| `/api/ready` 503 (cualquiera de las apps) | 2 fallos seguidos | WhatsApp+email   | Runbook "No se puede vender en POS" / `ROLLBACK.md` |
| Sentry: issue nuevo en producción         | 1                 | email/Slack      | Triage en < 1 h                                     |
| `webhook_events` failed                   | ≥ 1 / hora        | email            | Runbook MP                                          |
| Pedido web pendiente con pago aprobado    | > 30 min          | email            | Runbook MP                                          |
| `job_runs` failed o running > 1 h         | ≥ 1               | email            | Revisar log del job, marcar failed                  |
| Deriva de inventario                      | > 0 filas         | email            | `rebuild_inventory_levels()` + postmortem           |
| Stock agotado de producto activo          | ≥ 1               | notificación CRM | Producción                                          |
| Respaldo diario ausente                   | > 26 h            | email            | `BACKUP_RESTORE.md`                                 |
| Uso de pooler Supabase > 80 %             | 5 min             | Supabase         | Revisar `max` del pool / fugas                      |

Hasta que exista automatización de alertas (acción externa), esta lista se revisa **a diario** desde el
dashboard del CRM y una vez por semana con las consultas SQL.
