# Integraciones externas y observabilidad

> Mercado Pago México · Meta/Instagram Messaging · Resend · Sentry · logger · jobs/cron · webhooks idempotentes.
> Código: `packages/integrations/src/*`, `apps/web/app/api/webhooks/*`, `apps/*/app/api/cron/*`.

## Principios (no negociables)

- **Webhooks**: autenticados (firma), validados, **idempotentes** (`webhook_events unique(provider, external_id)`), registrados y reintentables. **Nunca** se confía en el payload para el estado del pago: siempre `GET /v1/payments/{id}`.
- **Externos** vía `fetchWithResilience` (timeout, backoff, circuit breaker). Reintentos solo en operaciones idempotentes (GET, o POST con `X-Idempotency-Key`/`Idempotency-Key`). El Send API de Instagram **no** reintenta (enviar dos veces = dos mensajes).
- **Dinero**: centavos enteros dentro del sistema; conversión a decimales solo en la frontera con la API (`centsToAmount`, `centsToAmountString`, `amountToCents`).
- **Secretos**: nunca en logs (el logger redacta `password|token|secret|card|authorization|cookie|signature|…`), nunca en el repo.

---

## 1. Mercado Pago México

### 1.1 Crear la aplicación y credenciales

1. Entra a <https://www.mercadopago.com.mx/developers/panel/app> con la cuenta **de la panadería** (la que recibirá el dinero).
2. **Crear aplicación** → nombre `El Pan de Paula` → producto: **Pagos online → Checkout Pro**. Si se usará terminal: activar también **Pagos presenciales → Point / QR** en la misma aplicación.
3. En la aplicación → **Credenciales de prueba**: copia `Access Token` (empieza con `TEST-`) → `MERCADOPAGO_ACCESS_TOKEN` en `.env` local / staging. Copia `Public Key` → `MERCADOPAGO_PUBLIC_KEY` (solo si el frontend usa Bricks/Wallet; Checkout Pro redirige y no la necesita).
4. **Credenciales de producción** (`APP_USR-…`): requieren completar la **homologación** (Mercado Pago pide una integración de prueba con calidad ≥ mínima y datos fiscales de la cuenta). Solo se ponen en Vercel → Production.
5. Nunca mezclar: credenciales de prueba se prueban con **usuarios de prueba** (Panel → Cuentas de prueba → crear comprador y vendedor) y **tarjetas de prueba**:

| Tarjeta    | Número              | CVV  | Venc. | Resultado (según nombre del titular) |
| ---------- | ------------------- | ---- | ----- | ------------------------------------ |
| Visa       | 4075 5957 1648 3764 | 123  | 11/30 | `APRO` aprobado · `OTHE` rechazado   |
| Mastercard | 5474 9254 3267 0366 | 123  | 11/30 | `CONT` pendiente · `FUND` sin fondos |
| Amex       | 3743 781877 55283   | 1234 | 11/30 | `SECU` CVV inválido · `EXPI` vencida |

(Ver la lista vigente en Panel → Credenciales de prueba → Tarjetas de prueba; puede cambiar.)

### 1.2 Webhook

1. Panel → tu aplicación → **Webhooks** → **Configurar notificaciones**.
2. Modo **Productivo**: URL `https://<dominio-del-sitio>/api/webhooks/mercadopago`. Modo **Prueba**: la misma ruta en el dominio de staging (o un túnel `https` local, p. ej. `cloudflared`/`ngrok`, apuntando a `:3106`).
3. Eventos: marcar **Pagos** (`payment`) y, si se cobra con terminal Point o QR, **Órdenes** (`order`). Los demás (`merchant_order`, etc.) se aceptan y quedan como `ignored`.
4. **Guardar** → aparece la **Clave secreta** → `MERCADOPAGO_WEBHOOK_SECRET`. Sin ella, **producción rechaza** toda notificación (500) y `development` acepta con un `warn`.
5. Botón **Simular** del panel → responde **500**, y eso es lo esperado: la simulación manda un `data.id` ficticio, el sistema lo consulta a la API, MP devuelve 404, el evento queda `failed` y MP reintenta (el cron también lo reintenta hasta 8 veces con backoff). Con un pago real se procesa y responde `200`. Un 401 en la simulación sí es problema: falta o no coincide `MERCADOPAGO_WEBHOOK_SECRET` en el entorno al que apunta la URL.

Cómo se valida (documentado en <https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks>):

```
x-signature: ts=<unix>,v1=<hmac-hex>
manifest  = "id:<data.id de la QUERY, en minúsculas si es alfanumérico>;request-id:<x-request-id>;ts:<ts>;"
v1        = HMAC-SHA256(manifest, MERCADOPAGO_WEBHOOK_SECRET) en hex   (valores ausentes se omiten del manifest)
```

Flujo del endpoint (`apps/web/app/api/webhooks/mercadopago/route.ts` + `apps/web/lib/webhooks/mercadopago.ts`):

```
raw body → parseMercadoPagoWebhook → verifyMercadoPagoSignature (401 si falla)
→ webhook_events (provider 'mercadopago', external_id = `${type}:${data.id}:${action}`)
   duplicado processed/ignored/processing → 200 {duplicate:true}
→ claim atómico (received/failed → processing, attempts++)
→ type = order → fetchMercadoPagoOrder(data.id) → external_reference = orders.id
     → apply_mercadopago_payment(external_id = id de la orden MP) (ver §1.5)
→ type ≠ payment/order → ignored
→ fetchMercadoPagoPayment(data.id)  (GET /v1/payments/{id}; error → failed + 500 ⇒ MP reintenta)
→ external_reference = orders.id (uuid y existente; si no → ignored)
→ apply_mercadopago_payment(jsonb) → record_payment/finalize_sale/record_refund en UNA transacción
→ processed (200)
```

Estados de MP que maneja `apply_mercadopago_payment`: `approved→paid`, `authorized`, `pending|in_process|in_mediation→pending`, `rejected→failed`, `cancelled`, `refunded|charged_back→refunded`. Duplicados del mismo pago con el mismo estado devuelven `{duplicate:true}` sin efectos.

### 1.3 Checkout Pro (pedidos web)

`createMercadoPagoPreference({ orderId, folio, items, payer?, backUrls, notificationUrl, expiresAt?, statementDescriptor? })`:

- `POST https://api.mercadopago.com/checkout/preferences` con `X-Idempotency-Key: pref:<orderId>` (reintentar no duplica preferencias).
- `items[].unit_price` en pesos con 2 decimales desde centavos, `currency_id: MXN`; `external_reference = orderId`; `metadata = {order_id, folio}`; `back_urls` + `auto_return: approved`; `statement_descriptor` (≤ 22 chars, default `EL PAN DE PAULA`); `expires/expiration_date_from/to` si `expiresAt`.
- Devuelve `initPoint` (producción) y `sandboxInitPoint` (pruebas). El checkout redirige a `init_point`.
- `notification_url` debe ser la URL pública del webhook (en local usa el túnel).

### 1.4 Reembolsos

`refundMercadoPagoPayment(paymentId, amountCents?, idempotencyKey?)` → `POST /v1/payments/{id}/refunds` (cuerpo `{amount}` para parcial, vacío para total) con `X-Idempotency-Key` (obligatorio para MP; por defecto uno aleatorio, **pásalo determinista** desde el admin, p. ej. `refund:<refund_id>`). Límite de MP: 180 días desde la aprobación y saldo disponible en la cuenta. El webhook `payment` con `status=refunded` luego concilia en DB vía `record_refund` (idempotente por `mp-refund:<payment_id>`).

### 1.5 Point y QR (POS) — API de Órdenes

Ambos usan `POST https://api.mercadopago.com/v1/orders` con `X-Idempotency-Key` (documentación: [Point](https://www.mercadopago.com.mx/developers/en/reference/in-person-payments/point/orders/create-order/post), [QR](https://www.mercadopago.com.mx/developers/en/reference/in-person-payments/qr-code/orders/create-order/post)). Montos como **string decimal** (`"120.00"`).

- **Point** (`createPointOrder`): `type: "point"`, `config.point.terminal_id = MERCADOPAGO_POINT_DEVICE_ID`, `print_on_terminal`, `transactions.payments[{amount}]`, `expiration_time PT15M`. **Requisitos en cuenta real (verificar)**: terminal vinculada a la cuenta, en modo **PDV** (`PATCH /terminals`), id según `GET /terminals`; Point **no** funciona con credenciales de prueba (se prueba con cobros reales mínimos y se reembolsan). El resultado llega por webhook (`orders`/`point_integration_wh`) o `fetchMercadoPagoOrder(id)`.
- **QR dinámico** (`createQrOrder`): `type: "qr"`, `config.qr.external_pos_id = MERCADOPAGO_QR_EXTERNAL_POS_ID`, `mode: "dynamic"`, `total_amount`, `items[]`. Devuelve `type_response.qr_data` (string EMV para renderizar como QR). **Requisitos (verificar)**: sucursal (`POST /users/{user_id}/stores`) y caja (`POST /pos`) creadas con `external_id`. El pago llega por webhook `orders`.
- **Conciliación (webhook `order`)**: `GET /v1/orders/{id}` → `external_reference` = `orders.id` → `apply_mercadopago_payment` con `external_id` = **id de la orden MP** (`ORD01…`), el mismo con el que el POS registró el pago `pending`. Así `processed` pasa ese pago a `paid` y `finalize_sale` cierra la venta en la misma transacción; los reenvíos son duplicados sin efecto. Estados: `processed→approved`, `failed→rejected`, `canceled|expired→cancelled`, `refunded→refunded`; `created|at_terminal|action_required` quedan `ignored` (el pago sigue `pending`). Los ids `PAY01…` de `transactions.payments[]` se guardan en `payments.metadata.mp_payment_ids` para conciliar con el panel. No se aplica por cada `PAY01…` porque crearía un segundo pago junto al `pending` del POS.
- Reembolsos parciales hechos desde la terminal/panel sobre una orden aún `processed` no se concilian automáticamente (solo `order.refunded` total).

### 1.6 Prueba local rápida

```bash
# 1) firma válida generada con node:crypto
SECRET=mi-secreto; TS=$(date +%s); RID=test-1; DATA=123456
V1=$(printf "id:%s;request-id:%s;ts:%s;" "$DATA" "$RID" "$TS" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -i "http://localhost:3106/api/webhooks/mercadopago?data.id=$DATA&type=payment" \
  -H "x-request-id: $RID" -H "x-signature: ts=$TS,v1=$V1" -H 'content-type: application/json' \
  -d '{"type":"payment","action":"payment.updated","data":{"id":"123456"}}'
```

Con `MERCADOPAGO_ACCESS_TOKEN` de prueba y un pago real de sandbox, `data.id` debe ser el id del pago: el pedido cuyo `orders.id` sea el `external_reference` pasa a `paid` y se crea la venta.

---

## 2. Meta / Instagram Messaging

### 2.1 Requisitos de la cuenta

- Cuenta de Instagram **profesional** (Business o Creator). Para el flujo **Instagram Login** (recomendado, sin Página de Facebook) el envío es `POST https://graph.instagram.com/v25.0/{IG_ID}/messages`. Si la cuenta está ligada a una Página y se usa **Facebook Login**, el envío es `https://graph.facebook.com/v25.0/{PAGE_ID}/messages` con Page Access Token → configura `INSTAGRAM_API_BASE=https://graph.facebook.com/v25.0` e `INSTAGRAM_ACCOUNT_ID=<page-id>`. **Verificar en cuenta real** cuál aplica.
- En la app de Instagram: Configuración → Privacidad → Mensajes → **Permitir acceso a mensajes** (activado).

### 2.2 App de Meta

1. <https://developers.facebook.com/apps> → **Crear app** → caso de uso _"Gestionar mensajes de Instagram"_ (o tipo _Business_) → nombre `El Pan de Paula`.
2. Panel → **Configuración de la app → Básica**: copia **Clave secreta de la app** → `META_APP_SECRET`.
3. Producto **Instagram → Configuración de la API con inicio de sesión de Instagram** → _Generar tokens de acceso_ → agrega la cuenta de la panadería → genera el token (60 días; renovar con `GET /refresh_access_token`) → `INSTAGRAM_PAGE_ACCESS_TOKEN`. Copia el **ID de la cuenta de Instagram** → `INSTAGRAM_ACCOUNT_ID`.
4. Permisos necesarios: `instagram_business_basic`, `instagram_business_manage_messages` (Instagram Login) o `instagram_manage_messages` + `pages_messaging` + `pages_manage_metadata` (Facebook Login).
5. **Webhooks** → objeto **Instagram** → _Configurar_: URL `https://<dominio-del-sitio>/api/webhooks/instagram`, **Verify token** = `META_VERIFY_TOKEN` (cualquier cadena larga: `openssl rand -hex 24`) → _Verificar y guardar_ (Meta hace `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; respondemos el challenge en texto plano). Suscribir campo **`messages`** (opcional: `messaging_postbacks`, `message_reactions`).
6. En modo **Desarrollo** solo llegan mensajes de usuarios con rol en la app (administradores/testers). Para el público: **Verificación del negocio** + **App Review** de `instagram_business_manage_messages` (o `instagram_manage_messages`) con video mostrando el flujo del bot → **Live**. Sin esto, el bot solo responde a testers.
7. Ventana de **24 h**: solo se puede responder a un usuario dentro de las 24 h posteriores a su último mensaje; fuera de ella el Send API devuelve error `(#10)` y el evento queda `failed` (visible en `webhook_events.last_error`).

### 2.3 Flujo del endpoint (`apps/web/app/api/webhooks/instagram/route.ts` + `apps/web/lib/webhooks/instagram.ts`)

```
GET  → verifyMetaWebhookChallenge(META_VERIFY_TOKEN) → 200 challenge | 403
POST → verifyMetaSignature(raw, X-Hub-Signature-256, META_APP_SECRET) (401 si falla; producción sin secreto → 500)
     → parseInstagramWebhook → por evento:
        · read/reaction/deleted → ignored
        · webhook_events (provider 'meta', external_id = `mid:<mid>` o `hash:<sha256>`) → duplicado → ignored
        · echo (mensaje enviado por la cuenta, incl. manual desde la app) → instagram_messages(out, auto_reply=false)
        · entrante → upsert instagram_conversations(ig_user_id) + instagram_messages(in)
        · flag instagram_bot → buildBotReply (reglas + catálogo real; IA si flag instagram_ai_replies + ANTHROPIC_API_KEY)
          → sendInstagramMessage → instagram_messages(out, auto_reply=true) → leads (source 'instagram', source_ref = conversación)
     → 200 siempre que los eventos quedaron registrados (fallos del bot → evento failed + last_error)
```

### 2.4 Bot (`packages/integrations/src/instagram.ts`)

- **Reglas** (`buildRuleReply`): intenciones `greeting, price, menu, availability, hours, location, how_to_order, delivery, pickup, order, thanks, human`. Detecta producto por tokens (plural/singular, coincidencia parcial) contra `catalog_products` con **precio web vigente**, stock (`inventory_levels`), horarios (`business_hours`), dirección (`business_settings`/`pickup_points`), entrega (`ordering_windows` de tipo `delivery` o `business_settings.policies.delivery.enabled`). **Siempre** incluye un enlace al sitio con `utm_source=instagram&utm_medium=dm&utm_campaign=bot`: `/menu`, `/producto/[slug]`, `/checkout`. Nunca muestra `$` si el producto no tiene precio.
- **IA opcional** (`buildAiReply`): `@anthropic-ai/sdk@0.125.0`, modelo `claude-sonnet-5`, `max_tokens 350`, `temperature 0.3`, timeout 8 s, 1 reintento. El system prompt lleva el contexto real en JSON y prohíbe inventar precios/disponibilidad/horarios/enlaces; usa la respuesta de reglas como base factual y **garantiza** un enlace del sitio. Cualquier fallo → respuesta por reglas. Historial: últimos 6 mensajes de la conversación.
- Texto saliente ≤ 1000 bytes UTF-8 (`truncateUtf8`).

---

## 3. Email (Resend)

1. <https://resend.com> → **Domains** → agrega `elpandepaula.mx` → crea los registros DNS (SPF/DKIM/MX de retorno) → _Verify_.
2. **API Keys** → _Create_ (permiso _Sending access_, dominio restringido) → `RESEND_API_KEY`.
3. `EMAIL_FROM="El Pan de Paula <pedidos@elpandepaula.mx>"` (debe ser del dominio verificado). Sin dominio verificado, Resend solo entrega a la cuenta dueña (útil en dev).
4. `sendEmail` → `POST https://api.resend.com/emails` con `Idempotency-Key` (≤ 256 chars, dedupe 24 h). Nunca lanza: devuelve `{sent:false, error}`; sin configuración devuelve `{skipped:"not_configured"}`.
5. Plantillas: `renderReceiptHtml` (comprobante: logo por URL, ítems, totales, pagos, puntos), `renderOrderConfirmationHtml` (botón "Ver estado de mi pedido" + "Completar pago" si está pendiente), `renderOrderStatusHtml` (cambio de estado). Todo texto de usuario pasa por `escapeHtml`; URLs por `safeUrl` (solo http/https). Claves de idempotencia deterministas: `receipt:<folio>:<to>`, `order-confirmation:<folio>:<to>`, `order-status:<folio>:<status>:<to>`.
6. El flag `email_receipts` decide en el POS si se envía el comprobante; las plantillas están listas para que el módulo de pedidos las llame.

---

## 4. Sentry

1. <https://sentry.io> → proyecto **Next.js** por app (`pdp-web`, `pdp-admin`) → copia el **DSN** → `SENTRY_DSN` (servidor/edge) y `NEXT_PUBLIC_SENTRY_DSN` (navegador).
2. Para subir source maps en el build: Settings → Auth Tokens → token con `project:releases` + `org:read` → `SENTRY_AUTH_TOKEN`, y `SENTRY_ORG`, `SENTRY_PROJECT`. **Sin token, `next.config.ts` no envuelve con `withSentryConfig`** (build más rápido en local); el SDK sigue activo en runtime si hay DSN.
3. Archivos por app: `instrumentation.ts` (carga `sentry.server.config.ts` / `sentry.edge.config.ts`, exporta `onRequestError = captureRequestError`), `instrumentation-client.ts` (navegador, `onRouterTransitionStart`), `lib/sentry-options.ts` (`environment = APP_ENV`, `release = VERCEL_GIT_COMMIT_SHA`, `tracesSampleRate 0.1`, `sendDefaultPii false`, `beforeSend` que elimina cookies/`Authorization`/firmas/IP/email), `app/global-error.tsx`.
4. Activo **solo si hay DSN**; sin DSN no se inicializa nada.

## 5. Logger

`createLogger(scope)` en `@pdp/integrations` → JSON por línea `{time, level, scope, msg, env, ...campos}`. Nivel por `LOG_LEVEL` (`debug|info|warn|error`, default `info`). Redacta claves sensibles recursivamente y tokens/tarjetas (Luhn) incrustados en strings. Úsalo en rutas y jobs en lugar de `console.log`.

## 6. Jobs / cron

`runJob(db, name, fn)` registra en `job_runs` (`running → succeeded|failed`), usa `lock_key` + índice único parcial para que no corran dos a la vez (`skipped`), y libera locks colgados (> 15 min). Rutas protegidas con `Authorization: Bearer <CRON_SECRET>` (`isCronAuthorized`, comparación en tiempo constante; Vercel Cron manda la cabecera automáticamente si `CRON_SECRET` existe en el proyecto).

| App   | Ruta                        | Programación (`vercel.json`) | Qué hace                                                                                                                                                                |
| ----- | --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web   | `/api/cron/webhooks-retry`  | `*/15 * * * *`               | Reprocesa `webhook_events` de Mercado Pago `received/failed` de 48 h (máx. 50, backoff `2^attempts` min, tope 6 h, máx. 8 intentos)                                     |
| admin | `/api/cron/sessions-purge`  | `0 9 * * *` (09:00 UTC)      | `purgeExpiredSessions` de `@pdp/auth`                                                                                                                                   |
| admin | `/api/cron/stock-alerts`    | cada 2 h (`0 */2 * * *`)     | Alertas de stock bajo/agotado e insumos críticos, sin duplicar abiertas (`run_stock_alerts()`)                                                                          |
| admin | `/api/cron/customer-events` | diario 14:30 UTC             | Cumpleaños (fecha local del negocio; el 29 de febrero se observa el 28 en años no bisiestos), inactividad 30/60 días, aniversarios → `customer_events` + notificaciones |

> Vercel Hobby limita los crons a una ejecución diaria; `*/15` requiere plan Pro. Si se despliega en Hobby, cambiar a `0 */1 * * *` no es posible tampoco: usar un cron externo (p. ej. GitHub Actions `schedule`) que haga `curl -H "Authorization: Bearer $CRON_SECRET"`.

Prueba local: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3106/api/cron/webhooks-retry`.

## 7. Variables de entorno

Nuevas en esta entrega (ya en `.env.example` y `turbo.json → globalEnv`): `MERCADOPAGO_QR_EXTERNAL_POS_ID`, `INSTAGRAM_API_BASE`. Usadas: `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `MERCADOPAGO_POINT_DEVICE_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `INSTAGRAM_PAGE_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID`, `RESEND_API_KEY`, `EMAIL_FROM`, `ANTHROPIC_API_KEY`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`, `CRON_SECRET`, `LOG_LEVEL`.

## 8. Pendientes / riesgos conocidos

- **Point/QR**: implementados contra la API de Órdenes vigente, con conciliación del webhook `order` probada con la API mockeada; **falta probar en cuenta real** (requieren terminal/caja reales; Point no funciona con credenciales de prueba).
- **Renovación del token de Instagram** (60 días): no hay job automático; documentar en el runbook de operación o agregar cron `instagram-token-refresh`.
- **App Review de Meta**: hasta obtener _Live_, el bot solo responde a testers de la app.
- **Homologación de Mercado Pago**: necesaria para credenciales de producción.
- **Vercel Cron cada 15 min** exige plan Pro (ver §6).
- Los emails transaccionales están listos pero **los dispara** el módulo de pedidos/POS (no esta entrega).
