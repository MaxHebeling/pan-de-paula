# Auditoría 360° — OPERACIÓN: POS, caja, pedidos, producción, inventario y notificaciones

- **Rama:** `audit/ops` (rebasada sobre `main` 138d448) · **Fecha:** 2026-09-12
- **Entorno:** worktree `pan-de-paula-wt/audit-ops`, base dev propia `pdp_audit_ops_dev` (seed + demo: 16 productos,
  374 ventas, 40 clientes), base de test `pdp_test_audit_ops`, `next dev` en `:3111`, Chromium (Playwright).
- **Usuarios de prueba:** `admin@elpandepaula.local` (super_admin), `cajera@audit.local` (cashier),
  `produccion@audit.local` (production).
- **Principio:** nada es PASS sin evidencia (test SQL, petición HTTP, E2E con verificación por SQL). BLOCKED cuando
  no se puede verificar sin credenciales externas.

## Resumen ejecutivo

| Métrica                                          | Valor                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Bugs encontrados y corregidos                    | **14** (P1: 6 · P2: 6 · P3: 2)                                                       |
| Hallazgos documentados sin corregir              | 9 (P2: 3 · P3: 6)                                                                    |
| Tests nuevos                                     | 33 SQL (`audit_ops.test.ts`) · 17 E2E (`audit-ops.spec.ts`) · 3 unit (`api.test.ts`) |
| Suites finales                                   | db 156/156 · domain 37/37 · admin 11/11 · E2E del área 24/24 (+18 skipped mobile)    |
| typecheck / lint / format / build / check-grants | verde (1 warning preexistente en `postcss.config.mjs`)                               |
| **Health score del área**                        | **84 / 100** (antes de la auditoría: ~62)                                            |

Los bugs más graves: **ventas offline que se perdían al expirar la sesión**, **dos ventas simultáneas de la última
pieza con stock negativo prohibido**, **pagos divididos idénticos que dejaban el pedido sin venta**, **efectivo de
pedidos que no entraba al corte de caja**, **cualquier cajero podía cancelar pedidos web/WhatsApp** y **conteos
físicos que aplicaban correcciones falsas** si hubo ventas mientras el conteo estaba abierto.

---

## 1. Inventario funcional

### Pantallas

| Ruta                               | Permiso           | Elementos                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/pos`                             | `pos.sell`        | Buscador (F2, Enter agrega el primero), pestañas Favoritos/Todos/categorías, tarjetas con variantes y badge de stock, carrito (±, nota, descuento por línea si `pos.refund`, eliminar, vaciar), cliente (búsqueda QR/código/teléfono/nombre, escáner de cámara, alta rápida), cupón, recompensas (aplicar emitida / canjear con puntos), totales, COBRAR (F9), cajón móvil, indicador de caja, indicador de sincronización offline, "Ventas del día" |
| Modal Cobrar                       | —                 | Efectivo (numpad, billetes rápidos, cambio, Enter), Tarjeta y Transferencia (referencia), MP Point / MP QR (solo con flag), Dividido (partes, resto exacto), total $0 (recompensa), Esc                                                                                                                                                                                                                                                              |
| Pantalla de venta                  | —                 | Folio, cambio, puntos, Imprimir, WhatsApp, Email (flag), Nueva venta (Enter/Esc)                                                                                                                                                                                                                                                                                                                                                                     |
| `/pos/ventas`                      | `pos.sell`        | Filtro fecha, búsqueda por folio, stats, detalle expandible, Recibo, Anular venta y Reembolso parcial (`pos.refund`)                                                                                                                                                                                                                                                                                                                                 |
| `/recibo/[orderId]`                | `pos.sell`        | Ticket 80 mm, auto-print `?print=1`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/caja`                            | `pos.register`    | Abrir (numpad, fondos rápidos, notas), resumen en vivo, cierre (numpad, "usar esperado", diferencia, confirmación), historial de 30 cortes                                                                                                                                                                                                                                                                                                           |
| `/caja/[sessionId]`, `/corte/[id]` | `pos.register`    | Resumen, ventas de la sesión, imprimir corte                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/pedidos`                         | `orders.read`     | Vistas Abiertos/Hoy/Próximos/Todos, búsqueda folio/teléfono/nombre, filtros estado/canal/pago/entrega, paginación 50                                                                                                                                                                                                                                                                                                                                 |
| `/pedidos/[id]`                    | `orders.read`     | Productos y totales, pagos (+reembolsar), pago manual, devoluciones (con/sin reingreso), línea de tiempo, cliente y entrega, transiciones, cancelar con motivo, notas internas, email (flag), Recibo, WhatsApp                                                                                                                                                                                                                                       |
| `/pedidos/nuevo`                   | `orders.write`    | Productos, cliente (sin registrar/existente/nuevo), canal, tipo de entrega, fecha/hora (TZ negocio), punto de retiro o dirección, cupón, pago inicial                                                                                                                                                                                                                                                                                                |
| `/pedidos/[id]/recibo`             | `orders.read`     | Comprobante imprimible                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/produccion`                      | `production.read` | Pestañas Hoy (+1/+5/+10/+20, manual, deshacer 2 min, "descontar ingredientes", alerta de insumos), Lotes (fecha/producto), Plan (fecha, sugerido, comprometidos por cliente, imprimir)                                                                                                                                                                                                                                                               |
| `/inventario`                      | `inventory.read`  | Stock (búsqueda, Ajustar: merma/corrección), Movimientos (producto/tipo/rango, paginación 100, enlaces), Mermas (registrar, hoy/7 días), Conteo (crear → capturar → revisar → aplicar/descartar, historial), Conciliación (rango, CSV), Insumos, Reconstruir niveles (gerencia)                                                                                                                                                                      |
| `/notificaciones`                  | sesión            | Filtros estado/tipo/alcance, marcar leída, marcar todas, paginación, contador                                                                                                                                                                                                                                                                                                                                                                        |

### Endpoints y cron

| Endpoint                               | Método   | Uso                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/pos/checkout`                    | POST     | Venta: `pos_checkout` (idempotente)                                                                                                                                                                                                                            |
| `/api/pos/coupon`                      | POST     | Previsualiza cupón con precios del servidor                                                                                                                                                                                                                    |
| `/api/pos/customers`                   | GET/POST | Búsqueda / alta rápida con deduplicación                                                                                                                                                                                                                       |
| `/api/pos/rewards`                     | GET/POST | Recompensas emitidas/disponibles · canje                                                                                                                                                                                                                       |
| `/api/pos/receipt`                     | POST     | print / whatsapp (wa.me) / email (flag + Resend)                                                                                                                                                                                                               |
| `/api/pos/payments/mercadopago`        | POST     | Inicia cobro Point/QR                                                                                                                                                                                                                                          |
| `/api/pos/payments/mercadopago/cancel` | POST     | Cancela intento Point/QR no confirmado                                                                                                                                                                                                                         |
| `/api/pos/payments/status`             | GET      | Polling del resultado del cobro                                                                                                                                                                                                                                |
| `/api/notifications/unread-count`      | GET      | Contador                                                                                                                                                                                                                                                       |
| `/api/cron/stock-alerts`               | GET/POST | `run_stock_alerts` con `Bearer CRON_SECRET` y lock en job_runs                                                                                                                                                                                                 |
| `/inventario/conciliacion/export`      | GET      | CSV de conciliación                                                                                                                                                                                                                                            |
| Server actions                         | —        | caja (abrir/cerrar), ventas (anular/reembolsar), pedidos (estado, cancelar, pago, reembolso, devolución, notas, crear, email, buscar cliente), producción (producir/deshacer), inventario (merma, ajuste, conteo ×4, reconstruir), notificaciones (leer/todas) |

### Funciones SQL del área

`pos_checkout`, `create_order`, `record_payment`, `finalize_sale`, `void_sale`, `record_refund`, `record_return`,
`change_order_status`, `order_transition_allowed`, `validate_coupon`, `redeem_reward`, `open_register`,
`close_register`, `register_expected_cash`, `register_session_summary`, `cancel_pending_pos_order`,
`record_production`, `undo_production`, `record_waste`, `record_stock_correction`, `create_stock_count`,
`set_stock_count_item`, `apply_stock_count`, `discard_stock_count`, `rebuild_inventory_levels`,
`inventory_reconciliation`, `suggested_production`, `run_stock_alerts`, `apply_mercadopago_payment`. Triggers
append-only en `inventory_movements`, `ingredient_movements`, `loyalty_transactions`, `domain_events`.

---

## 2. Matriz de cobertura

Evidencia: **S** = `packages/db/test/audit_ops.test.ts` (SQL real), **E** = `apps/admin/e2e/audit-ops.spec.ts`
(navegador + verificación SQL), **U** = test unitario, **X** = suites previas (`pos.spec`, `ops.spec`, `pos_sales`,
`ops.test`…) re-ejecutadas en verde.

### POS

| Caso                                                                                                                                                  | Resultado  | Evidencia                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Efectivo con cambio (UI, billete rápido, numpad)                                                                                                      | PASS       | E "caja + POS", X pos.spec                                                                                                                           |
| Pago dividido tarjeta+tarjeta idénticas                                                                                                               | PASS (fix) | S "dos partes con el MISMO método", E "caja + POS"                                                                                                   |
| Pago dividido efectivo+transferencia, reintento idempotente                                                                                           | PASS       | S "efectivo + tarjeta"                                                                                                                               |
| Partes que exceden el total / no lo cubren                                                                                                            | PASS (fix) | S "suma de partes que excede", S "pagos que no cubren", E "API POS"                                                                                  |
| Tarjeta / transferencia con referencia persistida                                                                                                     | PASS       | E "POS con caja cerrada" (`payments.reference = SPEI-AUD-001`)                                                                                       |
| Cliente por teléfono, código público, token QR                                                                                                        | PASS       | E "caja + POS", E "doble envío" (API por token y código)                                                                                             |
| Alta rápida (201) y deduplicación (200 `created:false`), teléfono inválido 400                                                                        | PASS       | E "doble envío"                                                                                                                                      |
| Cupón válido (10 %), inválido (mensaje), inexistente/inactivo/expirado/no iniciado/agotado/canal/mínimo/límite por cliente/producto ausente           | PASS       | S "cupones · cada motivo", E "caja + POS"                                                                                                            |
| Cobro con cupón inválido se rechaza completo                                                                                                          | PASS       | S "cupones"                                                                                                                                          |
| Recompensa: canje descuenta puntos, aplica descuento, queda `applied`, saldo = −costo + ganados                                                       | PASS       | E "doble envío"                                                                                                                                      |
| Descuento por línea: cajera sin botón y API 403; admin 201 con total del servidor                                                                     | PASS       | E "permisos", E "API POS"                                                                                                                            |
| Venta sin caja: pestaña efectivo deshabilitada, API 409 `REGISTER_CLOSED`                                                                             | PASS       | E "POS con caja cerrada"                                                                                                                             |
| Venta con sesión de caja ya cerrada (SQL)                                                                                                             | PASS       | S "vender con una sesión de caja cerrada"                                                                                                            |
| Idempotencia: doble clic simultáneo = 1 venta (201 + 200 duplicate)                                                                                   | PASS (fix) | E "doble envío", S "dos peticiones simultáneas con la misma idempotency_key"                                                                         |
| Cola offline: encola efectivo, rechaza tarjeta offline, sincroniza 1 vez, recarga no duplica                                                          | PASS       | E "cola offline", X offline-queue.test                                                                                                               |
| Cola offline con sesión expirada al volver la red                                                                                                     | PASS (fix) | E "sesión expirada", U api.test                                                                                                                      |
| Recibo imprimible (`/recibo/[id]`) con folio                                                                                                          | PASS       | E "caja + POS"                                                                                                                                       |
| Recibo WhatsApp (`wa.me/52…`), teléfono inválido 400, registro en `receipts`                                                                          | PASS       | E "caja + POS"                                                                                                                                       |
| Email con flag apagado → 409 `FLAG_OFF`                                                                                                               | PASS       | E "API POS"                                                                                                                                          |
| Email con flag encendido y Resend                                                                                                                     | BLOCKED    | Sin `RESEND_API_KEY`                                                                                                                                 |
| Anular venta: stock regresa (1 VOID), pedido/pagos cancelados, caja deja de esperar ese efectivo                                                      | PASS       | E "caja + POS", S "anular dos veces"                                                                                                                 |
| Anular tras reembolso parcial: solo puntos/gasto netos                                                                                                | PASS (fix) | S "anular una venta con reembolso parcial previo"                                                                                                    |
| Anular venta con cobro Mercado Pago                                                                                                                   | PASS (fix) | E "pedido sin pagar no ofrece 'Pagado'…"                                                                                                             |
| Reembolso parcial: stock no cambia, puntos proporcionales, `partially_refunded`                                                                       | PASS       | E "caja + POS", S "reembolsar más de lo pagado…"                                                                                                     |
| Atajos F2, F9, Esc, Enter en pantalla de éxito                                                                                                        | PASS       | E "doble envío"                                                                                                                                      |
| MP Point/QR flag apagado → 409 `FLAG_OFF`; encendido sin credenciales → 503 `MP_NOT_CONFIGURED`; UI con mensaje y "Otro método"; cero pedidos creados | PASS       | E "Mercado Pago"                                                                                                                                     |
| `payments` MP en `/api/pos/checkout` → 400 `MP_NOT_HERE`                                                                                              | PASS       | E "Mercado Pago"                                                                                                                                     |
| Cancelar cobro MP de pedidos no-POS                                                                                                                   | PASS (fix) | E "cancelar cobro MP desde el POS…"                                                                                                                  |
| Cobro real con terminal Point / QR y webhook aprobado                                                                                                 | BLOCKED    | Sin `MERCADOPAGO_ACCESS_TOKEN` / `POINT_DEVICE_ID`; la transición SQL del webhook sí se probó (X orders_payments, E con `apply_mercadopago_payment`) |
| Validación de entrada: qty 0/negativa, sin productos, uuid inválido, producto inexistente/inactivo/sin precio, JSON inválido                          | PASS       | E "API POS"                                                                                                                                          |
| Última pieza en dos pestañas (stock negativo prohibido)                                                                                               | PASS (fix) | E "dos pestañas…", S "dos pestañas venden la última pieza"                                                                                           |

### Caja

| Caso                                                                                  | Resultado  | Evidencia                                            |
| ------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| Abrir; segunda apertura imposible (UI y SQL concurrente)                              | PASS       | E "caja + POS", S "dos aperturas simultáneas"        |
| Resumen en vivo (efectivo esperado = fondo + efectivo − anulado)                      | PASS       | E "caja + POS"                                       |
| Cierre con diferencia (−$10) + notificación `register_difference`                     | PASS       | E "caja + POS", S "notificaciones por eventos"       |
| Dos cierres simultáneos: uno cierra, el otro `already_closed`, sin notificación falsa | PASS       | S "dos cierres de caja simultáneos"                  |
| Historial y detalle `/caja/[id]`; corte imprimible `/corte/[id]`                      | PASS       | E "caja + POS"                                       |
| Corte congelado si se anula una venta después del cierre                              | PASS (fix) | E "caja + POS", S "resumen de una sesión cerrada…"   |
| Vender en efectivo tras el cierre bloqueado                                           | PASS       | E "caja + POS"                                       |
| Cobro en efectivo de pedidos entra al corte                                           | PASS (fix) | E "cobro en efectivo de un pedido con caja abierta…" |

### Pedidos

| Caso                                                                                                                             | Resultado  | Evidencia                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Lista, vistas, filtros combinados, paginación (pág. 2 y regreso), cero resultados                                                | PASS       | E "pedidos"                                                    |
| Búsqueda con `%` y `_` literales (no lista todo)                                                                                 | PASS (fix) | E "pedidos"                                                    |
| URL con id inválido / inexistente → 404                                                                                          | PASS       | E "pedidos"                                                    |
| Pedido manual: cliente nuevo, cupón (case-insensitive), pago inicial parcial, fecha en TZ del negocio (`2026-12-24 18:30` local) | PASS       | E "pedidos", S "pedido manual con fecha…"                      |
| Pago manual en efectivo con cambio → venta + stock + cupón usado                                                                 | PASS       | E "pedidos", S "pago manual…"                                  |
| Pago manual: monto 0, recibido menor, sobrepago, reintento duplicado                                                             | PASS       | S "pago manual…"                                               |
| Reembolso desde pedido (`refundAction`)                                                                                          | PASS       | Misma función `record_refund` probada en S y E ventas          |
| Devolución sin/con reingreso; cantidad mayor a la vendida (acumulada); renglón ajeno; pedido sin venta                           | PASS (fix) | E "pedidos", S "devolución física"                             |
| Transiciones válidas por botones, inválidas ocultas                                                                              | PASS       | E "pedidos", X ops.spec                                        |
| Transiciones inválidas por llamada directa (SQL)                                                                                 | PASS       | S "transiciones inválidas por llamada directa"                 |
| "Pagado"/"Reembolsado" sin dinero                                                                                                | PASS (fix) | S "marcar Pagado o Reembolsado a mano…", E botón oculto        |
| Cancelar con motivo; cancelar con venta rechazado                                                                                | PASS       | E "pedidos", S "cancelar un pedido que ya tiene venta"         |
| Notas internas persistidas; refresh conserva el detalle                                                                          | PASS       | E "pedidos"                                                    |
| WhatsApp (`wa.me/52…`) y recibo imprimible                                                                                       | PASS       | E "pedidos"                                                    |
| Llamada HTTP directa a server actions con payload forjado                                                                        | BLOCKED    | Requiere el id interno de la acción; la regla se valida en SQL |

### Producción

| Caso                                                                                        | Resultado | Evidencia                                    |
| ------------------------------------------------------------------------------------------- | --------- | -------------------------------------------- |
| +1/+5/+10/+20 y manual actualizan tarjeta y `inventory_levels`                              | PASS      | E "producción"                               |
| Deshacer dentro de la ventana; fuera (lote envejecido por SQL) → mensaje "2 minutos"        | PASS      | E "producción", S "producción: 0, negativa…" |
| Lotes (incluye "Deshecho")                                                                  | PASS      | E "producción"                               |
| Plan con pedidos comprometidos (+500) y sin ellos; excluye cancelados/completados           | PASS      | E "producción", S "producción sugerida"      |
| Consumo de insumos: flag apagado no descuenta; checkbox descuenta receta; deshacer devuelve | PASS      | E "producción", S "consumo de insumos"       |
| Alerta de insumo crítico                                                                    | PASS      | S "consumo de insumos"                       |
| Cantidad 0/negativa/producto inexistente                                                    | PASS      | S                                            |
| Doble envío concurrente de producción                                                       | PASS      | S "doble envío de producción y de merma"     |
| Permisos: rol producción produce y ajusta; sin POS/caja/reconstruir                         | PASS      | E "permisos"                                 |

### Inventario

| Caso                                                                                                       | Resultado  | Evidencia                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| Stock y ajuste (corrección decimal +2.5)                                                                   | PASS       | E "inventario"                                              |
| Append-only: UPDATE/DELETE en movimientos, ledger de puntos y eventos                                      | PASS       | S "movimientos, ledger de puntos y eventos son append-only" |
| Mermas: cada uno de los 10 motivos → tipo (GIFT/INTERNAL_USE/WASTE); 0, negativa, motivo inválido; decimal | PASS       | S "merma", E "inventario" (sin validación HTML)             |
| Corrección manual: cero, motivo inválido, producto inexistente                                             | PASS       | S "corrección manual"                                       |
| Conteo: crear → capturar → revisar → aplicar; descartar                                                    | PASS       | E "inventario", X ops.spec                                  |
| Conteo con stock negativo; contado negativo rechazado; aplicar dos veces; cerrado no admite captura        | PASS       | S "conteo: contado negativo…", X stock_count_negative       |
| Segundo conteo abierto (secuencial y concurrente)                                                          | PASS (fix) | S "dos conteos físicos creados en paralelo"                 |
| Conteo con ventas mientras está abierto                                                                    | PASS (fix) | E "conteo abierto con ventas intermedias…"                  |
| Conciliación cruzando medianoche y fin de mes en TZ del negocio                                            | PASS       | S "conciliación: rangos que cruzan medianoche…"             |
| Exportar CSV (cabecera, rango inválido 400, fórmulas escapadas, negativos intactos)                        | PASS (fix) | E "inventario", E "…CSV escapa fórmulas"                    |
| Reconstruir niveles (desfase provocado) y concurrente con un movimiento                                    | PASS (fix) | E "inventario", S "rebuild_inventory_levels concurrente…"   |
| Movimientos con filtros (tipo con y sin resultados)                                                        | PASS       | E "inventario"                                              |
| Insumos                                                                                                    | PASS       | E "inventario"                                              |

### Notificaciones y cron

| Caso                                                                                                                 | Resultado  | Evidencia                      |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------ |
| Stock bajo → agotado sin duplicar; reponer cierra; cron idempotente                                                  | PASS       | S "notificaciones por eventos" |
| Pago rechazado, diferencia de caja, nuevo VIP                                                                        | PASS       | S "notificaciones por eventos" |
| Etiqueta y enlace "Ver corte" para diferencia de caja                                                                | PASS (fix) | E "notificaciones"             |
| Filtros, marcar leída (contador −1), marcar todas (contador 0)                                                       | PASS       | E "notificaciones"             |
| Cron sin secreto / secreto erróneo → 401; dos llamadas concurrentes → sin locks colgados; tercera sin nuevas alertas | PASS       | E "notificaciones", S (lock)   |
| Contador sin sesión → redirección (no JSON)                                                                          | PASS*      | E "permisos" (* ver P3-6)      |

---

## 3. Recorridos críticos verificados de punta a punta

1. **Turno completo:** abrir caja $500 → venta con cliente por teléfono + cupón + pago dividido → venta en efectivo
   con cambio → recibo impreso y WhatsApp → anular → reembolso parcial → venta tardía → cierre con −$10 →
   notificación → corte impreso → anular después del corte (corte intacto) → POS vuelve a bloquear efectivo.
   Cada paso verificado en `orders`, `payments`, `sales`, `inventory_movements`, `refunds`, `register_sessions`,
   `notifications`, `customers.points_balance`.
2. **Pedido de WhatsApp:** captura con cliente nuevo, fecha local y cupón → pago inicial parcial → saldo en efectivo
   con cambio (entra a la caja abierta) → devoluciones con y sin reingreso → recibo.
3. **Mostrador sin red:** venta en efectivo encolada → red de vuelta → sincronización única; con sesión expirada la
   venta queda en la cola con error y se registra una sola vez al reintentar tras iniciar sesión.
4. **Cocina:** producción rápida y manual → deshacer → plan con comprometidos → consumo de insumos → merma →
   conteo físico con ventas intermedias → conciliación y CSV.

---

## 4. Bugs corregidos (causa raíz · fix · test)

| #   | Sev. | Bug                                                                                                                                                                                | Causa raíz                                                                                                                                   | Fix                                                                                                                                              | Test de regresión                                                                     |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | P1   | **La cola offline perdía ventas** (y el POS mostraba una pantalla de venta rota) si la sesión expiraba: al volver la red la venta se daba por sincronizada sin llegar al servidor  | El proxy redirige `/api/*` sin cookie a `/login`; `fetch` sigue la redirección → 200 HTML; `apiFetch` lo trataba como éxito con `data: null` | `components/pos/api.ts`: redirección a `/login` → 401 `UNAUTHENTICATED`; 200 no-JSON → 502. `syncQueue` lo trata como 4xx (queda para reintento) | U `api.test.ts` (3), E "sesión expirada" (falló antes: quedó SINCRONIZADO sin pedido) |
| 2   | P1   | Con `allow_negative_stock=false`, **dos cajas vendían la última pieza** y el stock quedaba en −1                                                                                   | `finalize_sale` leía `inventory_levels` sin bloqueo antes de validar                                                                         | 0013: `insert … on conflict do nothing` + `select … for update` por producto en orden estable                                                    | S "dos pestañas venden la última pieza", E "dos pestañas…"                            |
| 3   | P1   | **Pago dividido con dos partes iguales** (2 × tarjeta $50) dejaba el pedido "partial" sin venta ni descuento de stock                                                              | `pos_checkout` derivaba la clave idempotente del pago como `idem:método:monto` → la 2.ª parte era "duplicado"                                | 0013: la clave incluye la posición del pago                                                                                                      | S "dos partes con el MISMO método", E "caja + POS"                                    |
| 4   | P1   | **Efectivo cobrado en pedidos no entraba al corte**: cierre con diferencia falsa                                                                                                   | `paymentAction` y el pago inicial de `createOrderAction` no enviaban `register_session_id`                                                   | `pedidos/actions.ts`: se liga a la caja abierta (si hay)                                                                                         | E "cobro en efectivo de un pedido con caja abierta" (falló antes: `null`)             |
| 5   | P1   | **Cualquier usuario con `pos.sell` podía cancelar pedidos web/WhatsApp/Instagram** no pagados vía `/api/pos/payments/mercadopago/cancel`                                           | `cancel_pending_pos_order` no filtra canal y la ruta aceptaba cualquier `orderId`                                                            | Ruta: 404 `NOT_POS_ORDER` si el pedido no es del POS                                                                                             | E "cancelar cobro MP…" (falló antes: 200 y pedido cancelado)                          |
| 6   | P1   | **Conteo físico con ventas intermedias aplicaba correcciones falsas** (contó 47 reales, quedaron 44)                                                                               | `apply_stock_count` usa el esperado congelado al crear el conteo; lo capturado después se comparaba contra un esperado viejo                 | `inventario/actions.ts`: al capturar un valor cambiado, el esperado se refresca al stock de ese momento; lo no tocado conserva su esperado       | E "conteo abierto con ventas intermedias" (falló antes: 44)                           |
| 7   | P2   | Doble clic simultáneo en Cobrar → 2.ª petición 409 "Ya existe un registro" en vez de respuesta idempotente                                                                         | Carrera entre la búsqueda por `idempotency_key` y el `insert` en `create_order`                                                              | 0013: `pos_checkout` captura `unique_violation` de `orders_idempotency_key_key` y devuelve `duplicate:true`                                      | S "dos peticiones simultáneas…", E "doble envío" (falló antes: 201+409)               |
| 8   | P2   | Anular una venta con reembolso parcial previo **revertía dos veces** puntos y gasto del cliente (afecta nivel)                                                                     | `void_sale` revertía todo lo ganado y el total, ignorando reversiones de `record_refund`                                                     | 0013: revierte el neto del ledger de la venta y `total − refunded`                                                                               | S "anular una venta con reembolso parcial previo"                                     |
| 9   | P2   | `record_return` aceptaba renglones de otro pedido, cantidades acumuladas mayores a lo vendido y pedidos sin venta (reingresaba stock inexistente)                                  | Sin validaciones en SQL; la acción solo comparaba contra la cantidad de UNA devolución                                                       | 0013: valida pertenencia, acumulado, venta vigente y producto con control de stock; evento `RETURN_RECORDED`                                     | S "devolución física", E "pedidos"                                                    |
| 10  | P2   | "Pagado" y "Reembolsado" se podían marcar a mano sin dinero: pedido "Pagado" → "Completado" sin venta, sin stock ni puntos                                                         | `change_order_status` solo validaba el grafo de estados                                                                                      | 0013: exige `paid_cents ≥ total` (o venta para $0) y reembolso registrado; la UI oculta "Pagado" con saldo                                       | S "marcar Pagado o Reembolsado a mano…", E botón oculto                               |
| 11  | P2   | Pagos que no cubren el total por API dejaban **pedidos POS parciales huérfanos**                                                                                                   | `pos_checkout` no verificaba que se concretara la venta                                                                                      | 0013: si no hay venta, excepción y rollback completo                                                                                             | S "pagos que no cubren el total", E "API POS"                                         |
| 12  | P2   | Anular una venta POS cobrada con Mercado Pago la marcaba cancelada **sin devolver el dinero** en MP; también aceptaba ventas web por id                                            | `voidSaleAction` no distinguía canal ni proveedor                                                                                            | `pos/ventas/actions.ts`: solo POS y sin cobros MP (usar reembolso)                                                                               | E "…anular venta POS cobrada por Mercado Pago se rechaza"                             |
| 13  | P3   | Dos conteos creados en paralelo quedaban abiertos; `rebuild_inventory_levels` concurrente perdía un movimiento; corte de una sesión cerrada cambiaba "esperado" tras una anulación | `exists` sin garantía; upsert con foto previa; resumen calculado en vivo                                                                     | 0013: índice único parcial `stock_counts_open_idx` y `lock … in share mode`; `lib/pos.ts` usa el esperado congelado                              | S "dos conteos…", S "rebuild… concurrente", E "caja + POS"                            |
| 14  | P3   | CSV de conciliación vulnerable a inyección de fórmulas; búsquedas con `%`/`_` listaban todo; notificaciones de caja/VIP sin etiqueta ni enlace                                     | `esc` propio sin protección; `ilike '%'                                                                                                      |                                                                                                                                                  | q                                                                                     |     | '%'`; `KIND_LABELS` incompleto | `csvCell` y `containsPattern` de `@pdp/domain` (pedidos, ventas, inventario, búsqueda de clientes POS y pedido manual); etiquetas y enlace a `/caja/[id]` | E "…CSV escapa fórmulas", E "pedidos", E "notificaciones" |

---

## 5. Problemas abiertos (documentados, no corregidos)

| ID   | Sev. | Hallazgo                                                                                                                                                                       | Reproducción / motivo                                                                                                                       | Recomendación                                                                                                                        |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| P2-1 | P2   | Reembolsos y anulaciones en efectivo de ventas de una sesión **ya cerrada** no descuentan de la caja del día (el dinero sale del cajón actual)                                 | Verificado por SQL (transacción revertida): venta $40 en sesión 1, cierre, abrir sesión 2, reembolso $40 → `register_expected_cash(s2) = 0` | Columna `register_session_id` en `refunds` (y en anulaciones) tomada de la caja abierta; requiere cambio de esquema                  |
| P2-2 | P2   | Venta offline en efectivo que se sincroniza cuando la caja ya se cerró → 409 `REGISTER_CLOSED`: el dinero está en mano pero la venta queda en error                            | Encolar offline, cerrar caja desde otra terminal, volver la red                                                                             | Permitir sincronizar a la sesión en la que se capturó (guardar `register_session_id` en la cola y aceptar sesiones cerradas del día) |
| P2-3 | P2   | Cobros en efectivo de pedidos con la caja **cerrada** se aceptan y quedan fuera de caja                                                                                        | Se decidió no bloquear (entregas a domicilio y `ops.spec` existente); queda visible como pago sin sesión                                    | Decidir política de negocio: bloquear efectivo sin caja o reporte de "efectivo fuera de caja"                                        |
| P3-1 | P3   | Descuento por línea mayor al importe de la línea se guarda tal cual en `order_items.discount_cents` (el total sí se limita a 0)                                                | Verificado por SQL: `create_order` con `discount_cents: 99999` en línea de $40 → `order_items.discount_cents = 99999`, total 0              | Limitar en `create_order` (0008) al importe bruto de la línea                                                                        |
| P3-2 | P3   | Tras un error de validación, React 19 reinicia los campos no controlados del formulario de merma (el producto vuelve a "Elige…")                                               | E "inventario" lo documenta con aserción                                                                                                    | Formularios controlados o devolver los valores en el estado de la acción                                                             |
| P3-3 | P3   | Conteo: si la persona teclea exactamente el mismo número que el esperado precargado habiendo ventas intermedias, no se refresca el esperado                                    | Caso límite del fix #6                                                                                                                      | Marcar explícitamente "contado" por renglón en la UI                                                                                 |
| P3-4 | P3   | `todayLocal`/`fmtDate` usan `BUSINESS_TZ` (env, por defecto Tijuana) y el enlace de lotes en Movimientos fija `America/Tijuana`, mientras SQL usa `business_settings.timezone` | Cambiar la zona en configuración desalinea "hoy" en `/pos/ventas`, mermas y enlaces                                                         | Leer la zona de `business_settings` en un helper único                                                                               |
| P3-5 | P3   | Comparación del `CRON_SECRET` no es de tiempo constante                                                                                                                        | Lectura de código                                                                                                                           | `timingSafeEqual`                                                                                                                    |
| P3-6 | P3   | `/api/*` sin sesión responde 307 a `/login` (HTML) en lugar de 401 JSON (el cliente del POS ya lo maneja)                                                                      | `curl -X POST /api/pos/checkout` → 307                                                                                                      | En `proxy.ts` (fuera del alcance) responder 401 JSON para rutas `/api/`                                                              |

---

## 6. BLOCKED

| Caso                                                   | Por qué                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cobro real Mercado Pago Point (terminal) y QR dinámico | Sin `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_POINT_DEVICE_ID`, `MERCADOPAGO_QR_EXTERNAL_POS_ID`. Se verificó flag apagado/encendido sin credenciales, cero pedidos huérfanos, polling de estado y la aplicación del webhook por SQL |
| Envío de comprobante por email                         | Sin `RESEND_API_KEY`/`EMAIL_FROM`; se verificó el 409 con flag apagado                                                                                                                                                              |
| Escáner QR con cámara (`BarcodeDetector`)              | Chromium headless sin cámara; se verificó la búsqueda por el token del QR                                                                                                                                                           |
| Impresión física 80 mm                                 | Sin impresora; se verificó el HTML del ticket y el corte                                                                                                                                                                            |
| Llamada HTTP forjada a server actions                  | Requiere id interno de la acción por build; las reglas se validan en SQL (S)                                                                                                                                                        |
| Proyecto `mobile` de `audit-ops.spec`                  | Caja y conteo son únicos por base: la suite corre solo en `desktop` para no pisarse (pos/ops.spec sí en ambos)                                                                                                                      |

---

## 7. Tests creados

- `packages/db/test/audit_ops.test.ts` — **33** casos SQL: pagos divididos, pagos incompletos, caja cerrada,
  concurrencia (última pieza, misma clave idempotente, dos cierres, dos aperturas, dos conteos, doble producción/merma,
  reconstrucción concurrente), anulación/reembolso/devolución, pagos y transiciones de pedidos (incluidos estados
  financieros), pedido manual con TZ y cupón, cada motivo de rechazo de cupón, append-only, mermas por motivo,
  correcciones, conteos, conciliación con TZ, producción e insumos, plan sugerido, notificaciones por evento, corte.
- `apps/admin/e2e/audit-ops.spec.ts` — **17** recorridos E2E con verificación SQL (permisos por rol, caja cerrada,
  turno completo, idempotencia/alta rápida/QR/recompensa/atajos, Mercado Pago, cola offline, dos pestañas, pedidos,
  producción, inventario, notificaciones y cron, caja↔pedidos, cancelación MP, conteo con ventas, Pagado/anular MP/CSV,
  sesión expirada, validación de API).
- `apps/admin/components/pos/api.test.ts` — **3** unitarios del cliente HTTP del POS.
- Migración `packages/db/migrations/0013_audit_ops.sql` (solo `create or replace` de funciones de 0006/0008 + índice
  parcial). **Pre-requisito en producción:** `select count(*) from stock_counts where status = 'open'` ≤ 1. Se aplica
  después de 0080 (el runner aplica pendientes sin exigir orden) y `_post_migrate.sql` re-otorga privilegios.

## 8. Riesgos residuales

- **Dinero fuera de caja** (P2-1/P2-2/P2-3): el corte sigue siendo sensible a reembolsos de sesiones pasadas y a
  ventas offline sincronizadas con la caja cerrada.
- **Mercado Pago real sin probar**: polling, cancelación y webhook con la API real pueden revelar estados no mapeados.
- **Conteos largos**: el fix #6 depende de que la captura ocurra junto al conteo físico; conteos capturados horas
  después siguen siendo aproximados.
- La suite E2E del área depende de una base con seed y usuarios `cajera@audit.local` / `produccion@audit.local`
  (se crean con `hashPassword` de `@pdp/auth`); en CI hay que sembrarlos.

## 9. Health score del área: **84 / 100**

| Dimensión                                    | Peso | Nota | Comentario                                                    |
| -------------------------------------------- | ---- | ---- | ------------------------------------------------------------- |
| Integridad de dinero, stock y puntos         | 30   | 25   | Transacciones SQL sólidas; quedan P2 de caja fuera de sesión  |
| Concurrencia e idempotencia                  | 15   | 14   | Carreras críticas cubiertas con tests de dos conexiones       |
| Permisos y superficie de API                 | 15   | 13   | Hueco de cancelación cerrado; 307 en vez de 401 (P3)          |
| Resiliencia (offline, sesión, integraciones) | 15   | 11   | Pérdida offline corregida; MP real BLOCKED                    |
| UX de operación (errores claros, atajos)     | 10   | 9    | Mensajes claros; formulario de merma se reinicia (P3)         |
| Cobertura de tests del área                  | 15   | 12   | 53 casos nuevos + suites previas; mobile solo en pos/ops.spec |
