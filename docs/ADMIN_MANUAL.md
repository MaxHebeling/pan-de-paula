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

| Ruta            | Permiso         | Qué hace                                                                                                                                                                                  | Qué verificar                                                                          |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/productos`    | `catalog.*`     | Alta/edición: nombre, slug, categoría, variantes (productos hijos), imágenes, alérgenos, visibilidad web/POS, control de stock, bajo pedido, temporada, favorito POS                      | Producto con precio antes de activarlo; `show_on_web` solo si tiene foto y descripción |
| `/categorias`   | `catalog.*`     | Categorías y orden                                                                                                                                                                        | Orden que quieres en la tienda                                                         |
| `/ingredientes` | `recipes.*`     | Insumos, unidad base, proveedor, **historial de precios**, stock mínimo                                                                                                                   | Precio por unidad = precio ÷ contenido                                                 |
| `/recetas`      | `recipes.*`     | Receta por producto, rendimiento, costo por pieza, margen, ingredientes sin precio; pestaña **Hoja de costos** (`/recetas/hoja`) editable celda por celda; fórmulas visibles en cada fila | Margen objetivo; ninguna receta con "precios faltantes"                                |
| `/precios`      | `catalog.write` | Precios regulares por canal (`all/web/pos`) y **promociones con vigencia**; historial                                                                                                     | Que la promo tenga fecha fin; el precio nuevo cierra al anterior automáticamente       |

### Clientes

| Ruta            | Permiso                            | Qué hace                                                                                                                                                     | Qué verificar                                                                  |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `/clientes`     | `customers.*`                      | Ficha: código `PDP-000123`, QR, contacto, cumpleaños, consentimiento, nivel, puntos, historial de compras, eventos (hitos, inactividad); fusionar duplicados | Un cliente por teléfono; fusiona en vez de borrar                              |
| `/fidelizacion` | `customers.read` / `loyalty.write` | Programa de puntos (puntos por cada $N, mínimo, multiplicador de cumpleaños, bono de alta), niveles, recompensas, bonos por producto                         | Que los puntos que ve el cliente coincidan con el ledger (no se editan a mano) |
| `/cupones`      | `customers.read` / `loyalty.write` | Cupones: %/monto/producto gratis, vigencia, canales, usos, segmento (solo nuevos, niveles)                                                                   | Cupones vencidos inactivos; `uses_count` vs `max_uses`                         |
| `/instagram`    | `marketing.*`                      | Conversaciones y mensajes de Instagram, leads, respuestas (bot si el flag está activo)                                                                       | Leads convertidos enlazados a pedido                                           |

#### Correo obligatorio y acceso del cliente a su cuenta

Desde septiembre de 2026 el correo es **obligatorio** al dar de alta o editar un cliente en el CRM y en
`/unete` del sitio: es la llave con la que el cliente entra a su propia cuenta (`/portal`) y ve su nivel,
sus puntos, su QR y todas sus compras. No lo piden la alta rápida del POS ni la captura de un pedido
manual (ahí lo que importa es cobrar o registrar el pedido); en esos casos el correo queda opcional y se
puede completar después desde la ficha, sin duplicar al cliente ni perder puntos, QR ni historial.

**Los clientes de siempre no se tocan.** Los que llegaron sin correo (importación, mostrador) siguen
exactamente igual. Cuando te den su correo, edítalo en su ficha y listo.

**Darle acceso a su cuenta**: ficha del cliente → **Acceso a su cuenta en el sitio** →
_Generar enlace de acceso_. Sirve una sola vez, vence en una hora y se copia con un botón para
mandárselo por WhatsApp o dárselo en el mostrador. Requiere permiso de edición de clientes y queda
registrado en la auditoría.

> Hoy hace falta hacerlo a mano porque el envío de correos todavía no está configurado en producción.
> Cuando se active, el propio cliente podrá pedirse el enlace desde el sitio y además se lo enviaremos.

#### Cumpleaños y saludos

**Dónde**: `/fidelizacion` → pestaña **Tablero** → tarjeta **🎂 Cumpleaños de hoy** (cantidad, nombre, fecha,
nivel con su color, estado del saludo y acciones) y, debajo, **Próximos cumpleaños (30 días)**.
El saludo de cada cliente vive en `/clientes/<id>/cumpleanos` (también desde el botón "🎂 Saludo de cumpleaños"
de su ficha). Todo exige sesión: nada de esto se publica en el sitio.

**Cómo funciona el día a día**

1. **Detección** — el cron diario (`/api/cron/customer-events`, 14:30 UTC) crea el evento `birthday` y la
   notificación, usando la **fecha local del negocio** (`business_settings.timezone`), no la UTC.
2. **Generación** — "Preparar saludo" guarda una fila en `birthday_greetings` con el texto, el nivel del
   momento y quién lo preparó. La clave es `(cliente, año)`: **un saludo por cliente y año**.
3. **Previsualización** — la tarjeta premium (imprimible) y el texto exacto que se va a enviar.
4. **Aprobación / envío** — botón de **WhatsApp** con el mensaje prellenado (el staff lo manda desde su
   teléfono: no hay API de WhatsApp), **correo** (solo si Resend está configurado) o **entregado en persona**.
5. **Registro** — se guardan `sent_at`, `sent_by` y `channel`, y el evento del día queda "gestionado".
   Al volver a la página ya no hay botones de envío: **no se envía un segundo saludo**.

**Regla del 29 de febrero** (definida en SQL, migración `0042`, funciones `observed_birthday` y
`celebrates_birthday_on`):

- **Año bisiesto** → se felicita el **29 de febrero** (fecha exacta).
- **Año no bisiesto** → se felicita el **28 de febrero** (último día de febrero).
- La edad de ese día es la diferencia de años (quien nació el 29-02-2000 cumple **27** el 28-02-2027).
- La página del saludo lo avisa con una alerta para que el staff sepa por qué la fecha no coincide.

**Qué verificar**: que el texto no prometa beneficios que no existen. El único beneficio que se menciona es
el real del programa de puntos (`loyalty_program.birthday_multiplier`), y solo si el programa está activo.

### Analítica y sistema

| Ruta              | Permiso               | Qué hace                                                                                                                                                                                                        |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/reportes`       | `reports.read/export` | Ventas por día/producto/canal, rentabilidad (precio vs costo snapshot), mermas, conciliación de inventario, caja, clientes; exportar                                                                            |
| `/notificaciones` | —                     | Avisos internos: nuevo pedido pagado, pago rechazado, stock bajo/agotado, nuevo VIP, cumpleaños                                                                                                                 |
| `/configuracion`  | `settings.write`      | Datos del negocio, zona horaria, IVA (`prices_include_tax`, `tax_rate_bps`), stock negativo, umbral de stock bajo, horarios, ventanas de pedido, excepciones de calendario, puntos de retiro, **feature flags** |
| `/usuarios`       | `staff.write`         | Staff, roles, activar/desactivar, restablecer contraseña                                                                                                                                                        |
| `/auditoria`      | `audit.read`          | Quién cambió qué y cuándo (`audit_logs`: productos, precios, clientes, pedidos, pagos, caja, configuración, flags)                                                                                              |

## Hoja de costos y fórmulas

Todo el módulo Catálogo se edita "como hoja de cálculo": clic (o Enter/F2) en una celda numérica abre el editor,
**Enter guarda, Esc cancela, Tab guarda y pasa a la siguiente celda**. Mientras escribes ves una vista previa en
cursiva calculada en el navegador; al guardar, **el servidor (SQL) recalcula y muestra la verdad**. Las fórmulas
aparecen con los números sustituidos en cada pantalla (▸ Fórmula).

### Dónde se edita en línea

| Pantalla                    | Celdas editables                                                                                                                  | Qué crea / cambia                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/recetas/hoja`             | MO (o minutos si la MO es por hora), indirectos (si son fijos), rendimiento, merma %, margen objetivo, precio POS, precio web     | Parámetros de la receta (la crea si no existía); los precios crean un **precio regular nuevo**    |
| `/recetas/[producto]`       | Todo el editor + merma %, margen objetivo, minutos de MO; botón **$** en cada línea registra un precio nuevo del insumo sin salir | `upsert_recipe_v2`; `record_ingredient_price`; **Aplicar precio sugerido** crea el precio regular |
| `/ingredientes`             | Último precio (precio + contenido + unidad) y stock mínimo                                                                        | Nuevo precio histórico del insumo (nunca se edita el anterior); muestra costo unitario e impacto  |
| `/productos`                | Precio POS, precio web, interruptores Activo / Web / POS / Destacado / Fav. POS                                                   | Precio regular nuevo; banderas del producto                                                       |
| `/categorias`               | Nombre y orden                                                                                                                    | —                                                                                                 |
| `/precios/[producto]`       | Nuevo precio con margen en vivo y botón **Usar sugerido**                                                                         | Precio regular nuevo                                                                              |
| `/configuracion` › Fórmulas | Parámetros globales con **simulador** (elige un producto y compara guardado vs simulado antes de guardar)                         | `costing_settings` (auditado)                                                                     |

### Columnas de la hoja de costos

| Columna          | Significado                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Ingredientes ($) | Σ (cantidad × costo unitario vigente) de cada insumo, **por lote**. Ámbar si algún insumo no tiene precio      |
| MO               | Mano de obra por lote. Con MO "por hora": minutos ÷ 60 × tarifa (una receta sin minutos usa su monto por lote) |
| Indirectos       | Monto fijo por lote o, si está configurado, % de los insumos (entonces no se edita: se calcula)                |
| Rendimiento      | Piezas que salen del lote                                                                                      |
| Merma %          | Desperdicio estimado. Vacío = default global ("def."); un valor = override de la receta                        |
| Costo/pieza      | Resultado de la fórmula (abajo)                                                                                |
| Precio POS / web | Precio vigente por canal (`current_price_cents`). Editar crea un regular nuevo en ese canal                    |
| Margen           | Sobre el precio POS. **Verde** en meta · **ámbar** bajo el objetivo · **rojo** negativo                        |
| Margen obj.      | Objetivo para el sugerido. Vacío = default global; un valor = override de la receta                            |
| Sugerido         | Precio para alcanzar el objetivo, redondeado hacia arriba al múltiplo configurado                              |
| Aplicar sugerido | Crea un precio regular igual al sugerido (en `all` y en el canal que tuviera regular propio)                   |

Filtros: búsqueda, categoría, "bajo objetivo", "negativo", "insumos sin precio", "sin receta". **Exportar CSV**
incluye las fórmulas en texto. La fila final trae Σ por lote, promedios y cuántos productos están bajo objetivo.

### Las fórmulas

```
Costo unitario del insumo = precio pagado ÷ contenido (en g / ml / pz)          ej. $400.00 ÷ 1,808 g = $0.2212/g
Insumos por lote          = Σ cantidad × costo unitario
Mano de obra              = monto por lote  |  minutos ÷ 60 × tarifa por hora
Indirectos                = monto por lote  |  insumos × %
Costo por pieza           = (insumos + MO + indirectos) ÷ rendimiento × (1 + merma)   ej. ($152.70 + $0 + $0) ÷ 12 × (1 + 0%) = $12.73
Margen                    = (precio − costo) ÷ precio                                 ej. ($45.00 − $12.73) ÷ $45.00 = 71.7%
Precio sugerido           = costo ÷ (1 − margen objetivo) → hacia arriba al múltiplo  ej. $12.73 ÷ (1 − 60%) = $31.83 → $32.00
```

Sin merma, con MO por lote e indirectos fijos, el costo es exactamente el de siempre. El redondeo del costo es
half-up a centavos; el del sugerido es **siempre hacia arriba** (0.50, 1, 5 o 10 pesos).

### Cambiar los parámetros

`/configuracion?tab=formulas` (permiso `settings.write`): margen objetivo por defecto, múltiplo de redondeo,
merma por defecto, modo de mano de obra (por lote / por hora + tarifa) y modo de indirectos (fijo / % de insumos).
Usa el simulador para ver cómo cambian costo, margen y sugerido de un producto **antes** de guardar. Al guardar
se recalculan todos los productos al instante (no se guardan costos: se calculan siempre desde la verdad).
Los overrides por receta (merma y margen objetivo) se fijan en la hoja o en el editor; una celda vacía vuelve al default.

### Reglas que protegen los datos

- Los precios históricos **nunca** se editan: cada cambio cierra el vigente y crea uno nuevo (queda quién y cuándo).
- Los precios de insumos son un historial: registrar uno nuevo no toca los anteriores; las ventas pasadas guardan su costo.
- Todo cambio pasa por el servidor con tu sesión (`withStaff`) y queda en `/auditoria`, incluidos los parámetros de fórmulas.
- Permisos: recetas y hoja → `recipes.write`; precios y banderas de producto → `catalog.write`; parámetros → `settings.write`.

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
