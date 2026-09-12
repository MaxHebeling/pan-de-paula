# Manual del CRM (administración)

> Para dueño y gerencia. El CRM vive en `admin.elpandepaula.mx` (local: `http://localhost:3001`).
> El menú se define en `apps/admin/lib/nav.ts`; cada sección requiere un permiso y solo aparece si tu rol lo tiene.
>
> **Aviso:** las pantallas se están construyendo en paralelo por módulos (catálogo, POS, operación, clientes,
> integraciones, sitio público). Este manual describe **qué hace cada ruta y qué debes verificar en ella**
> según la arquitectura y las reglas ya implementadas en la base de datos. Las rutas que ya existen hoy son
> `/login`, `/dashboard` y `/cuenta/contrasena`; el resto se irá publicando con su módulo.

## Acceso y roles

- **Login** (`/login`): email + contraseña. 5 intentos fallidos bloquean la cuenta 15 minutos; también hay
  límite por IP. La sesión dura 14 días y se cierra desde el menú de cuenta. Cambio de contraseña en
  `/cuenta/contrasena` (obligatorio la primera vez para el admin sembrado).
- **Roles** (`/usuarios`, permiso `staff.write`): `super_admin`, `owner` (todo), `manager` (todo menos usuarios),
  `cashier` (POS, caja, pedidos, clientes), `production` (producción, inventario, recetas), `sales`
  (pedidos, clientes, POS, reportes), `marketing` (Instagram, fidelización, cupones, reportes).
  Nadie edita a un rol superior al suyo. Desactiva usuarios en vez de borrarlos (auditoría).

## Mapa del CRM

### Operación

| Ruta          | Permiso             | Qué hace                                                                                                                                                                                                                               | Qué verificar                                                                                                             |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard`  | `dashboard.read`    | Ventas de hoy y del mes (total, tickets, costo, reembolsos), pedidos abiertos y con pago pendiente, entregas de hoy, stock bajo/agotado, top productos 30 días                                                                         | Que la venta de hoy coincida con la caja; que no haya pedidos "pago pendiente" viejos                                     |
| `/pos`        | `pos.sell`          | Punto de venta (ver `POS_MANUAL.md`)                                                                                                                                                                                                   | —                                                                                                                         |
| `/pedidos`    | `orders.read/write` | Lista y detalle de pedidos (web, POS, Instagram, WhatsApp, admin): estado, pago, entrega, historial. Cambiar estado (`confirmado → en producción → listo → entregado`), cancelar (libera cupón), registrar pago manual (transferencia) | Pedidos web con pago aprobado deben estar en `paid`; cancelar solo pedidos sin venta (si ya hay venta: anular/reembolsar) |
| `/produccion` | `production.*`      | Sugerencia diaria, registrar lotes, historial (ver `PRODUCTION_MANUAL.md`)                                                                                                                                                             | Lotes registrados el día que se hornean                                                                                   |
| `/inventario` | `inventory.*`       | Stock por producto, movimientos, mermas, conteos, insumos                                                                                                                                                                              | Que el nivel = suma de movimientos (botón/consulta de reconstrucción si hay dudas)                                        |
| `/caja`       | `pos.register`      | Abrir/cerrar caja, esperado vs contado, diferencia                                                                                                                                                                                     | Una caja abierta a la vez; diferencias explicadas en nota                                                                 |

### Catálogo

| Ruta            | Permiso         | Qué hace                                                                                                                                                             | Qué verificar                                                                          |
| --------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/productos`    | `catalog.*`     | Alta/edición: nombre, slug, categoría, variantes (productos hijos), imágenes, alérgenos, visibilidad web/POS, control de stock, bajo pedido, temporada, favorito POS | Producto con precio antes de activarlo; `show_on_web` solo si tiene foto y descripción |
| `/categorias`   | `catalog.*`     | Categorías y orden                                                                                                                                                   | Orden que quieres en la tienda                                                         |
| `/ingredientes` | `recipes.*`     | Insumos, unidad base, proveedor, **historial de precios**, stock mínimo                                                                                              | Precio por unidad = precio ÷ contenido                                                 |
| `/recetas`      | `recipes.*`     | Receta por producto, rendimiento, costo por pieza, margen, ingredientes sin precio                                                                                   | Margen objetivo; ninguna receta con "precios faltantes"                                |
| `/precios`      | `catalog.write` | Precios regulares por canal (`all/web/pos`) y **promociones con vigencia**; historial                                                                                | Que la promo tenga fecha fin; el precio nuevo cierra al anterior automáticamente       |

### Clientes

| Ruta            | Permiso                            | Qué hace                                                                                                                                                     | Qué verificar                                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/clientes`     | `customers.*`                      | Ficha: código `PDP-000123`, QR, contacto, cumpleaños, consentimiento, nivel, puntos, historial de compras, eventos (hitos, inactividad); fusionar duplicados | Un cliente por teléfono; fusiona en vez de borrar                              |
| `/fidelizacion` | `customers.read` / `loyalty.write` | Programa de puntos (puntos por cada $N, mínimo, multiplicador de cumpleaños, bono de alta), niveles, recompensas, bonos por producto                         | Que los puntos que ve el cliente coincidan con el ledger (no se editan a mano) |
| `/cupones`      | `customers.read` / `loyalty.write` | Cupones: %/monto/producto gratis, vigencia, canales, usos, segmento (solo nuevos, niveles)                                                                   | Cupones vencidos inactivos; `uses_count` vs `max_uses`                         |
| `/instagram`    | `marketing.*`                      | Conversaciones y mensajes de Instagram, leads, respuestas (bot si el flag está activo)                                                                       | Leads convertidos enlazados a pedido                                           |

### Analítica y sistema

| Ruta              | Permiso               | Qué hace                                                                                                                                                                                                        |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/reportes`       | `reports.read/export` | Ventas por día/producto/canal, rentabilidad (precio vs costo snapshot), mermas, conciliación de inventario, caja, clientes; exportar                                                                            |
| `/notificaciones` | —                     | Avisos internos: nuevo pedido pagado, pago rechazado, stock bajo/agotado, nuevo VIP, cumpleaños                                                                                                                 |
| `/configuracion`  | `settings.write`      | Datos del negocio, zona horaria, IVA (`prices_include_tax`, `tax_rate_bps`), stock negativo, umbral de stock bajo, horarios, ventanas de pedido, excepciones de calendario, puntos de retiro, **feature flags** |
| `/usuarios`       | `staff.write`         | Staff, roles, activar/desactivar, restablecer contraseña                                                                                                                                                        |
| `/auditoria`      | `audit.read`          | Quién cambió qué y cuándo (`audit_logs`: productos, precios, clientes, pedidos, pagos, caja, configuración, flags)                                                                                              |

## Feature flags (en `/configuracion`)

| Flag                     | Default | Enciende…                                        |
| ------------------------ | ------- | ------------------------------------------------ |
| `web_checkout`           | on      | Finalizar pedidos en el sitio                    |
| `mercadopago_online`     | off     | Cobro online con Checkout Pro                    |
| `mercadopago_point`      | off     | Terminal Point en POS                            |
| `mercadopago_qr`         | off     | QR dinámico en POS                               |
| `instagram_bot`          | off     | Respuestas automáticas                           |
| `instagram_ai_replies`   | off     | Respuestas con IA (requiere `ANTHROPIC_API_KEY`) |
| `ingredient_consumption` | off     | Producción descuenta insumos                     |
| `email_receipts`         | off     | Comprobantes por email                           |
| `loyalty`                | on      | Motor de puntos                                  |
| `pos_offline_queue`      | off     | Cola offline del POS (solo efectivo)             |

Apagar un flag es la forma más rápida de contener un problema sin desplegar (ver `ROLLBACK.md`).

## Rutinas del administrador

- **Diario**: dashboard → pedidos con pago pendiente → notificaciones → cierre de caja.
- **Semanal**: precios de insumos nuevos → márgenes en `/recetas` → mermas de la semana → cupones/promos vigentes.
- **Mensual**: reporte de rentabilidad, clientes inactivos (eventos `inactive_30`), simulacro de respaldo
  (`BACKUP_RESTORE.md`), revisión de usuarios activos.

## Migración desde la hoja de cálculo

Ver `MIGRATION_SHEETS.md`. Resumen: exportar XLSX → mapeo → simular → revisar reporte → aplicar → verificar en
las rutas de arriba. Nunca se borra el histórico.
