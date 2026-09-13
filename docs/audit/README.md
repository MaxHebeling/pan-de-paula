# Auditoría 360° — Informe consolidado

**Fecha:** 13 de septiembre de 2026 · **Alcance:** todo el monorepo (sitio público y tienda, CRM/POS, base de datos, integraciones, infraestructura) · **Base auditada:** `main` 576df36 · **Resultado publicado:** ver §11.

Detalle por área, con inventario funcional, matriz completa y reproducciones:

| Área                                                                   | Informe                  | Health score del área (antes → después de la auditoría) |
| ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| Autenticación, autorización, seguridad, administración                 | [auth.md](auth.md)       | ~66 → 90                                                |
| Operación: POS, caja, pedidos, producción, inventario                  | [ops.md](ops.md)         | ~62 → 85                                                |
| Catálogo, clientes, fidelización, cupones, reportes, búsqueda          | [catalog.md](catalog.md) | 62 → 90                                                 |
| Sitio público y tienda                                                 | [web.md](web.md)         | — → 93                                                  |
| Integraciones, webhooks, jobs, importador, base de datos, build, smoke | [infra.md](infra.md)     | 68 → 91                                                 |

Las cifras "después" de auth, catálogo e infra incluyen las correcciones transversales hechas al integrar (§5).

## 1. Resumen ejecutivo

El sistema ya estaba en producción y con CI en verde. La auditoría encontró **101 defectos reales** que los tests existentes no detectaban, **2 de ellos P0**: funciones de negocio ejecutables por el rol anónimo de Supabase y una tarjeta de cliente que se abría con el teléfono de otra persona. Producción no tenía clientes ni pedidos, así que ninguno expuso datos reales. Se corrigieron **94**, cada uno con un test que falla sin el arreglo. Los **7 abiertos** son P2/P3 de caja y de configuración que requieren una decisión de negocio o un cambio de esquema.

## 2. Software health score

**87 / 100.** No es más alto por: pagos online y en terminal, email, Instagram y Sentry sin verificar con credenciales reales; CSP con `'unsafe-inline'`; casos borde de caja abiertos; sin PITR ni monitor de uptime externo.

| Dimensión                    | Estado                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Correctitud funcional        | Alta: 437/448 verificaciones PASS con evidencia, 0 FAIL                                                           |
| Protección contra regresión  | Alta: 94 regresiones cubiertas por tests nuevos                                                                   |
| Build y análisis estático    | Verde: lint sin advertencias, typecheck, formato, `pnpm audit` sin vulnerabilidades                               |
| Base de datos                | Integridad verificada en producción (inventario, puntos, pagos, cupones); RLS en todo; 0 objetos expuestos a anon |
| Autenticación y autorización | 7 roles × 27 páginas y 92 server actions verificadas por HTTP y SQL                                               |
| Integraciones                | Verificadas con mocks, firmas calculadas y fixtures oficiales; reales BLOCKED                                     |
| Observabilidad               | Health/ready, smoke E2E permanente, `job_runs`, alertas por SQL; Sentry sin DSN                                   |

## 3. Cobertura funcional

"Verificación" = una fila de las matrices de cobertura de los cinco informes (funcionalidad o caso de una funcionalidad, con evidencia).

| Métrica                     | Valor                                       |
| --------------------------- | ------------------------------------------- |
| Verificaciones descubiertas | 448                                         |
| Verificadas                 | 437                                         |
| PASS                        | 437 (89 de ellas fallaban y se corrigieron) |
| FAIL                        | 0                                           |
| BLOCKED / NOT VERIFIED      | 11                                          |
| **Cobertura verificada**    | **97.5 %**                                  |

## 4. Recorridos críticos

| Recorrido                                                                                                       | Resultado                                       |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Visitante → menú → producto → carrito → checkout (pago al recoger) → página del pedido                          | PASS                                            |
| Visitante → `/unete` → tarjeta digital con QR                                                                   | PASS                                            |
| Login → abrir caja → venta en efectivo con cambio → recibo → cierre de caja con diferencia 0                    | PASS                                            |
| Producción +N → inventario → merma → conteo físico → conciliación → exportar CSV                                | PASS                                            |
| Pedido manual → pago → estados válidos → entrega → devolución                                                   | PASS                                            |
| Cliente → ajuste de puntos → canje de recompensa → cupón → reporte diario → CSV                                 | PASS                                            |
| Ingrediente sube de precio → costo de receta → hoja de costos → aplicar precio sugerido                         | PASS                                            |
| Login por rol → acceso solo a lo permitido (páginas y acciones directas)                                        | PASS                                            |
| Webhook Mercado Pago aprobado → venta → inventario → puntos (con duplicados, fuera de orden y montos distintos) | PASS con mocks · real BLOCKED                   |
| Mensaje de Instagram → bot → lead (con reintento sin respuestas duplicadas)                                     | PASS con mocks · real BLOCKED                   |
| Respaldo de producción → restauración en base nueva                                                             | PASS (simulacro con volcado real de producción) |
| Deploy → migraciones → verificación de permisos → smoke HTTP y E2E contra dominios de producción                | PASS                                            |

## 5. Problemas encontrados y corregidos

| Área                                            | Encontrados | Corregidos | Abiertos |
| ----------------------------------------------- | ----------- | ---------- | -------- |
| Autenticación y administración                  | 25          | 24         | 1        |
| Operación                                       | 22          | 16         | 6        |
| Catálogo y clientes                             | 22          | 22         | 0        |
| Sitio público                                   | 12          | 12         | 0        |
| Integraciones e infraestructura                 | 17          | 17         | 0        |
| Transversal (detectado al integrar y desplegar) | 3           | 3          | 0        |
| **Total**                                       | **101**     | **94**     | **7**    |

**P0**

- Supabase concede privilegios por defecto a los objetos nuevos: 31 funciones de negocio y 2 tablas creadas después de la migración de seguridad eran accesibles por `anon`. Corregido con la migración 0080, un endurecimiento que corre al final de cada migración, `scripts/check-grants.sh` en el deploy (ahora cubre tablas, vistas, secuencias y funciones) y test.
- `/mi-tarjeta/<teléfono|correo|código>` mostraba nombre, puntos y enlace permanente de otra persona. Ahora solo abre con el token opaco.

**P1 (selección)**

- Mercado Pago: pagos de monto distinto, sobre pedidos cancelados o duplicados quedaban en `failed` con el dinero cobrado sin registrar; eventos atorados en `processing` nunca se reintentaban.
- POS: ventas offline perdidas al expirar la sesión; dos cajas vendían la última pieza; pago dividido con partes idénticas dejaba el pedido sin venta; efectivo de pedidos fuera del corte de caja; un cajero podía cancelar pedidos web ajenos.
- Conteo físico con ventas durante el conteo aplicaba correcciones erróneas.
- `/unete` con un teléfono existente abría y modificaba la cuenta de otra persona.
- No se podía crear ninguna promoción desde el CRM; `"45,50"` se guardaba como $4,550.00.
- Los respaldos no eran restaurables en una base nueva, y al corregirlo el respaldo previo al deploy fallaba por intentar volcar la bóveda de Supabase.

**P2/P3 (selección)**: búsqueda global que ignoraba permisos de rol; búsqueda con `+52` y comodines `%`/`_`; inyección de fórmulas en CSV; Sentry que enviaba `access_token`; cron de cumpleaños duplicado por usar el día UTC; ajuste de puntos que sumaba dos veces con doble envío; CSRF que permitía cerrar la sesión de otra persona; token de restablecimiento reutilizable en paralelo; enumeración de cuentas; sesiones que nunca expiraban; mensajes crudos de Postgres al usuario; un dueño podía restablecer la contraseña de otro dueño; ausencia de Content-Security-Policy.

Cada corrección está descrita con causa raíz, cambio y test en el informe de su área.

## 6. Tests

| Suite                                                          | Antes (576df36) | Después                      |
| -------------------------------------------------------------- | --------------- | ---------------------------- |
| Unitarios e integración (6 paquetes)                           | 247             | 474                          |
| E2E Playwright (web + admin, Chromium móvil y escritorio)      | 31              | 139 (20 omitidos por diseño) |
| Smoke E2E de solo lectura contra producción (`pnpm smoke:e2e`) | —               | 19                           |

Tests destacados creados: `security_grants`, `audit_auth`, `audit_ops`, `audit_catalog`, `audit_infra`, `audit_web` (SQL); `redact`, `text`, `calendar_audit_web` (dominio); `webhook-audit-infra`, `checkout-actions`, `club-actions`, `sentry-options` (web); `audit-auth`, `audit-ops`, `audit-catalog`, `audit-web`, `search-regression`, `points-idempotency`, `smoke` (E2E).

## 7. Build y análisis estático (ejecución final)

Todo en verde: escaneo de secretos, 23 migraciones válidas, permisos sin exposición (base de desarrollo y base recién sembrada), formato, `pnpm audit --prod` sin vulnerabilidades, lint sin advertencias, typecheck, 474 tests, build de ambas apps y 139 E2E sobre una base recién sembrada igual que CI.

## 8. Integraciones

| Integración                                     | Estado                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Supabase (base, RLS, grants, pooler, TLS)       | PASS en producción y staging                                                |
| Supabase Storage                                | PASS con mocks · real BLOCKED (sin uso todavía)                             |
| Mercado Pago Checkout Pro, webhooks, reembolsos | PASS con firmas calculadas y respuestas simuladas · real BLOCKED            |
| Mercado Pago Point / QR                         | PASS de flags y errores sin credenciales · real BLOCKED (requiere terminal) |
| Meta / Instagram (webhook, bot, envío)          | PASS con fixtures oficiales · real BLOCKED                                  |
| Claude para el bot                              | PASS del fallback a reglas · real BLOCKED                                   |
| Resend                                          | PASS con mocks y registro en `receipts` · real BLOCKED                      |
| Sentry                                          | PASS de redacción e inicialización condicional · DSN no configurado         |
| Vercel (deploy, crons, cabeceras)               | PASS                                                                        |

## 9. Riesgos residuales y abiertos

1. **Caja (P2, requiere decisión o cambio de esquema):** reembolsos o anulaciones en efectivo de una sesión ya cerrada no se descuentan de la caja del día; una venta offline que sincroniza después del cierre queda en error; el efectivo cobrado en un pedido con la caja cerrada se acepta pero no se cuenta en ningún corte (decidir: bloquear o reportar).
2. **P3 de operación:** descuento de línea mayor que la línea se guarda tal cual (el total queda en $0 correctamente); el formulario de merma se limpia tras un error; la zona horaria se lee de dos lugares.
3. **P3 de autenticación:** el límite por IP confía en `X-Forwarded-For` (correcto detrás de Vercel; no fuera de él).
4. **CSP con `'unsafe-inline'`:** necesaria sin nonces de Next; bloquea orígenes externos, framing, `<object>`, `<base>` y envíos a terceros.
5. **"Ya soy cliente"** confirma un nombre parcial a quien escriba un teléfono existente; mitigado con límite de 20 intentos por 10 minutos.
6. **Sin PITR ni monitor de uptime externo**; los respaldos son `pg_dump` por deploy y manuales.
7. **Integraciones reales sin probar:** mantener apagados los flags de pagos, bot y email hasta verificarlos en sandbox.

## 10. BLOCKED / no verificado y cómo desbloquearlo

| #   | Qué                                                           | Qué falta                                                                                                            |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Cobro real con Checkout Pro y reintento de pago               | Credenciales de prueba de Mercado Pago y `MERCADOPAGO_WEBHOOK_SECRET`; pagar con tarjeta de prueba desde `/checkout` |
| 2   | Cobro con terminal Point y QR                                 | Terminal vinculada y `MERCADOPAGO_POINT_DEVICE_ID` / `MERCADOPAGO_QR_EXTERNAL_POS_ID`                                |
| 3   | Envío y rechazo reales de Meta, ventana de 24 h               | App de Meta aprobada, `INSTAGRAM_PAGE_ACCESS_TOKEN`, `META_APP_SECRET`                                               |
| 4   | Respuestas del bot con Claude                                 | `ANTHROPIC_API_KEY` y flag `instagram_ai_replies`                                                                    |
| 5   | Correos transaccionales                                       | `RESEND_API_KEY` con dominio verificado                                                                              |
| 6   | Supabase Storage real                                         | `STORAGE_DRIVER=supabase` ya configurado; subir una imagen desde Productos                                           |
| 7   | Sentry real                                                   | `SENTRY_DSN` y `NEXT_PUBLIC_SENTRY_DSN`                                                                              |
| 8   | Importación del Google Sheets real                            | Exportar la hoja y seguir `docs/MIGRATION_SHEETS.md`                                                                 |
| 9   | Cámara QR del POS e impresión física                          | iPad/tablet con cámara e impresora de 80 mm                                                                          |
| 10  | Server actions con payload forjado en operación               | Cubierto por tests SQL; sin herramienta de invocación directa en esa área                                            |
| 11  | Cookie `Secure` sobre HTTPS real y navegadores WebKit/Firefox | Prueba manual en el dominio de producción desde Safari y Firefox                                                     |

## 11. Veredicto

**APTO CON OBSERVACIONES.**

Los recorridos que el negocio necesita hoy (venta en mostrador con efectivo o terminal externa, caja, producción, inventario, pedidos con pago al recoger o transferencia, club de clientes, catálogo y costos) están verificados de punta a punta, con la base íntegra y sin superficie expuesta. Las observaciones son dos: los casos borde de caja del §9.1 deben resolverse o conocerse antes de operar con varios turnos, y los pagos online, en terminal Point/QR, el bot y los correos no deben activarse hasta completar los desbloqueos del §10.
