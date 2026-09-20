# Arquitectura — El Pan de Paula

> Sistema operativo digital de la panadería: sitio público + tienda, CRM, POS, producción, inventario, costos, fidelización, Instagram y reportes sobre **una sola base de datos y una sola lógica de negocio**.

## Vista general

```
┌──────────────────────┐      ┌──────────────────────────┐
│ apps/web  (público)  │      │ apps/admin (CRM/POS)      │
│ Next 16 · :3000      │      │ Next 16 · :3001           │
│ catálogo, checkout,  │      │ dashboard, POS, producción│
│ QR de clientes,      │      │ inventario, clientes,     │
│ webhooks MP/Meta     │      │ fidelización, reportes    │
└──────────┬───────────┘      └────────────┬─────────────┘
           │  @pdp/domain (reglas puras)   │  @pdp/auth (sesiones staff)
           │  @pdp/integrations (MP, Meta, email, storage)
           └───────────────┬───────────────┘
                     @pdp/db (Kysely tipado)
                           │
                 ┌─────────▼──────────┐
                 │ Postgres 17        │  ← migraciones SQL = fuente de verdad
                 │ (Supabase en prod) │  ← funciones transaccionales de negocio
                 └────────────────────┘
```

## Decisiones clave

| Tema                 | Decisión                                                                                                                                                                                                                                     | Por qué                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo             | pnpm workspaces + Turborepo                                                                                                                                                                                                                  | Dos apps con identidades visuales distintas comparten DB, dominio, auth e integraciones sin sincronizaciones frágiles.                                                                               |
| Base de datos        | Postgres 17. Migraciones SQL numeradas e inmutables (`packages/db/migrations`). Tipos generados con `kysely-codegen`.                                                                                                                        | Una sola fuente de verdad; el esquema, las restricciones y la lógica crítica viven en la base y son verificables con tests de integración.                                                           |
| Lógica crítica       | Funciones SQL (`pos_checkout`, `record_payment`, `finalize_sale`, `record_production`, `record_waste`, `apply_mercadopago_payment`, `void_sale`, `record_refund`, `close_register`, …)                                                       | Venta + pago + inventario + puntos + cupón + eventos ocurren en **una transacción**. No existe "se cobró pero no se descontó stock". Idempotencia por `idempotency_key` / `(provider, external_id)`. |
| Dinero               | Enteros en centavos (MXN). Costos unitarios de insumos en `numeric(18,8)` (MXN por g/ml/pz).                                                                                                                                                 | Sin floats. Los tests de dominio y de DB verifican paridad de cálculo.                                                                                                                               |
| Inventario           | Append-only (`inventory_movements`) + nivel materializado por trigger (`inventory_levels`) + `rebuild_inventory_levels()`                                                                                                                    | Historial completo, conciliable y reconstruible. UPDATE/DELETE prohibidos por trigger.                                                                                                               |
| Histórico financiero | `order_items` guarda precio, descuento y **costo snapshot**; `sales` es inmutable (solo `voided_at`).                                                                                                                                        | Cambios futuros de catálogo/recetas no reescriben ventas pasadas.                                                                                                                                    |
| Precios              | `product_prices` con canal (all/web/pos), tipo (regular/promo) y vigencia. `current_price_cents()` resuelve.                                                                                                                                 | Nada hardcodeado en frontend; historial y promociones con fechas.                                                                                                                                    |
| Costeo               | `ingredient_prices` con historial → `ingredient_unit_cost(at)` → `product_cost_cents(product, at)`                                                                                                                                           | Reproduce el Google Sheets: precio → contenido → costo unitario → receta → rendimiento → costo por pieza. Recalcula al cambiar un insumo sin tocar ventas pasadas.                                   |
| Auth staff           | Propia: argon2id + sesiones en DB (cookie httpOnly, hash sha256 del token), bloqueo tras 5 fallos, rate limit por IP, reset por token de un uso.                                                                                             | Testeable en local y CI sin servicios externos; roles y permisos granulares en tablas.                                                                                                               |
| Clientes             | `public_code` (PDP-000143) y `qr_token` opaco; resolución solo en backend (`find_customer`). Correo obligatorio en las altas humanas.                                                                                                        | Registro por QR en 30 segundos; el QR no expone datos.                                                                                                                                               |
| Portal del cliente   | `/portal` en `apps/web`. Sin contraseña: enlace de un solo uso (`customer_access_tokens`) + sesión en cookie httpOnly (`customer_sessions`), mismo diseño que las sesiones de staff. Toda consulta filtra por el `customer_id` de la sesión. | El cliente ve su nivel, puntos, QR y compras leyendo las MISMAS tablas que el CRM, sin copias ni sincronización. Ver `CUSTOMER_PORTAL.md`.                                                           |
| Seguridad DB         | RLS en todas las tablas; `anon`/`authenticated`/`PUBLIC` sin privilegios; rol `pdp_app` con mínimo privilegio.                                                                                                                               | En Supabase, PostgREST no expone nada aunque la clave anon se filtre.                                                                                                                                |
| Webhooks             | Tabla `webhook_events` `unique(provider, external_id)`; firma verificada; el estado del pago se **consulta a la API** (no se confía en el payload); procesamiento idempotente.                                                               | Duplicados no duplican pagos, ventas, stock ni puntos.                                                                                                                                               |
| Externos             | `fetchWithResilience`: timeout, reintentos con backoff, circuit breaker por host. Feature flags en DB.                                                                                                                                       | Mercado Pago / Meta / email pueden fallar sin tumbar la operación.                                                                                                                                   |
| Observabilidad       | `/api/health` (liveness), `/api/ready` (DB + migraciones), Sentry (release + environment), `domain_events`, `audit_logs`, `job_runs`.                                                                                                        | Saber qué pasó, cuándo y quién.                                                                                                                                                                      |

## Módulos (packages/db/migrations)

| Archivo                   | Contenido                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001_foundation           | extensiones, `business_settings`, `feature_flags`, roles/permisos, staff + sesiones, auditoría (trigger genérico), `domain_events`, notificaciones, `job_runs`                   |
| 0002_catalog              | categorías, productos (variantes = productos hijos), imágenes, precios con historial, `current_price_cents`, vista `catalog_products`                                            |
| 0003_ingredients_recipes  | proveedores, ingredientes, `ingredient_prices` (historial), recetas, `product_cost_cents`, vista `recipe_costing`                                                                |
| 0004_customers_loyalty    | clientes (código + QR), direcciones, niveles, programa de puntos, ledger, recompensas, canjes, cupones, eventos de cliente                                                       |
| 0005_commerce             | puntos de retiro, horarios, ventanas de pedido, excepciones de calendario, pedidos, ítems, historial de estado, caja, ventas, pagos, reembolsos, devoluciones, comprobantes      |
| 0006_inventory_production | movimientos (append-only), niveles, lotes de producción, mermas, conteos, movimientos de insumos, vista `stock_status`                                                           |
| 0007_ops_integrations     | `webhook_events`, Instagram (conversaciones/mensajes), leads, campañas, importaciones con trazabilidad                                                                           |
| 0008_transactions         | todas las funciones transaccionales de negocio                                                                                                                                   |
| 0009_security             | rol `pdp_app`, revocaciones, RLS en todo                                                                                                                                         |
| 0017_productos_especiales | `products.is_temporary` (+ índice parcial): marca los productos especiales/temporales. No agrega modelo: el precio sigue en `product_prices` y el stock en `inventory_movements` |
| 0043_customer_portal      | correo obligatorio en `register_customer` (con excepción documentada), `customer_access_tokens`, `customer_sessions`                                                             |
| 0044_phone_international  | `normalize_phone_digits`; `find_customer` y `register_customer` comparan teléfonos con o sin `+` (México igual que antes; sin migrar datos, ver `DATABASE.md` → Teléfonos)       |

## Flujos críticos

**Venta POS (efectivo)**: UI → `POST /api/pos/checkout` (zod) → `withStaff(staffId)` → `pos_checkout(jsonb)` → crea `orders`+`order_items` (precio del servidor, costo snapshot) → `record_payment` → `finalize_sale` → `sales`, `inventory_movements(SALE)`, puntos, cupón, estadísticas del cliente, `order_status_history`, `domain_events`, notificaciones de stock bajo → respuesta con folio, cambio y puntos.

**Pedido web con Mercado Pago**: checkout → `create_order` (status `new`) → preferencia de Checkout Pro con `external_reference = order.id` → cliente paga → webhook `POST /api/webhooks/mercadopago` → verificar `x-signature` → guardar en `webhook_events` (idempotente) → consultar `GET /v1/payments/{id}` → `apply_mercadopago_payment` → `finalize_sale` cuando `approved`.

**Producción**: tablet → `record_production(product, qty)` → lote + `inventory_movements(PRODUCTION)` (+ consumo de insumos si el flag `ingredient_consumption` está activo) → cierra alertas de stock bajo.

**Conciliación**: `inventory_reconciliation(from, to)` = apertura + producción − ventas − mermas ± correcciones. Conteo físico → `apply_stock_count` → movimientos `CORRECTION`.

## Ambientes

| Ambiente    | DB                                                   | Apps                   | Deploy                                                      |
| ----------- | ---------------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| development | Postgres local (`pan_de_paula`, `pan_de_paula_test`) | `pnpm dev`             | —                                                           |
| staging     | Supabase `pan-de-paula-staging`                      | Vercel preview/staging | `pnpm deploy:staging`                                       |
| production  | Supabase `pan-de-paula`                              | Vercel producción      | `pnpm deploy:prod` (solo desde `main`, con respaldo previo) |

Ver `DEPLOYMENT.md`, `ROLLBACK.md`, `BACKUP_RESTORE.md`, `RELIABILITY.md`, `CUSTOMER_PORTAL.md`.
