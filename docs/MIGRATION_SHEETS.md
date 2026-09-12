# Migración desde Google Sheets

> Guía para el dueño y para quien lo acompañe. Objetivo: pasar lo que hoy vive en la hoja de cálculo
> (productos, ingredientes, recetas, precios, clientes y pedidos históricos) al sistema **sin perder nada,
> sin duplicar nada y pudiendo revisar antes de escribir**.

## Principios

1. **Nunca se borra el histórico.** La hoja de cálculo se conserva tal cual (descárgala completa y guárdala).
   El sistema no borra ni "limpia" nada: solo agrega registros y guarda cada fila importada con su original.
2. **Primero se simula, luego se aplica.** Todo comando corre en modo simulación (`--dry-run`) por defecto y
   genera un reporte. Solo cuando el reporte te convence, repites el comando con `--apply`.
3. **Repetir no duplica.** Puedes correr el mismo archivo dos veces: lo que ya existe se marca "Ya existe"
   y no se crea otra vez. Si algo se parece a un registro existente pero no es idéntico, **no se fusiona**:
   se omite y se explica en el reporte para que decidas tú.
4. **Trazabilidad total.** Cada corrida queda en `import_batches` y cada fila en `import_rows`
   (fila original → fila normalizada → registro creado). Siempre se puede saber de dónde salió cada dato.

## Paso 0 · Exportar la hoja

En Google Sheets: **Archivo → Descargar → Microsoft Excel (.xlsx)**. Un solo archivo con todas las pestañas
es lo más cómodo (el importador elige la pestaña con `--sheet` o con `"sheet"` en el mapeo).
Alternativa por pestaña: **Archivo → Descargar → Valores separados por comas (.csv)**.

Recomendaciones antes de exportar:

- La **fila 1** debe tener los encabezados (Producto, Ingrediente, Precio, …). Si hay títulos arriba, usa
  `"header_row": N` en el mapeo o borra esas filas en una copia.
- Un dato por celda: "1.808 kg" debe ser Contenido `1.808` y Unidad `kg` en dos columnas.
- Dinero con o sin `$` y comas está bien: `$1,234.50`, `1234.5` y `26,50` se entienden.
  Fechas en `dd/mm/aaaa` (o celdas de fecha reales de Excel).
- **Recetas**: si en la hoja cada receta es una tablita aparte, conviértela a formato largo: una fila por
  ingrediente con las columnas `Producto | Ingrediente | Cantidad | Unidad | Rendimiento` (el rendimiento
  puede ir solo en la primera fila de cada producto).
- **Pedidos por cliente** (una fila por pedido, una columna por producto con la cantidad): se importan tal
  cual con el mapeo `pedidos.json` (formato ancho). Si tienes una fila por producto, usa `pedidos-largo.json`.

## Paso 1 · Preparar el mapeo

Un mapeo es un JSON que dice _qué columna del archivo va a qué campo del sistema_ y cómo se interpreta.
Hay plantillas listas en `packages/db/import/mappings/`:

| Entidad     | Plantilla            | Columnas que espera (ajustables en `"from"`)                                                 |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------- |
| ingredients | `ingredientes.json`  | Ingrediente, Marca, Precio, Contenido, Unidad, Presentación, Proveedor, Vigente desde        |
| products    | `productos.json`     | Producto, Categoría, Precio, Descripción, Activo                                             |
| recipes     | `recetas.json`       | Producto, Ingrediente, Cantidad, Unidad, Rendimiento                                         |
| prices      | `precios.json`       | Producto, Precio, Canal, Desde                                                               |
| customers   | `clientes.json`      | Cliente, Teléfono, Email, Cumpleaños, Promos                                                 |
| orders      | `pedidos.json`       | Cliente, Teléfono, Fecha, Total, Punto de entrega, Pagado, Método + una columna por producto |
| orders      | `pedidos-largo.json` | Cliente, Fecha, Producto, Cantidad, Precio unitario                                          |

Copia la plantilla, cámbiale los `"from"` para que coincidan con tus encabezados y quita las columnas que no
tengas. `--mapping` acepta una ruta o solo el nombre de la plantilla (`--mapping ingredientes`); las rutas
relativas se resuelven desde la carpeta donde ejecutas el comando (sirve desde la raíz del repo) (si mapeas una columna que no existe en el archivo, el importador se detiene y te dice cuáles hay).

Estructura:

```json
{
  "entity": "ingredients",
  "sheet": "Ingredientes",
  "header_row": 1,
  "columns": {
    "name": { "from": "Ingrediente", "transform": "text", "required": true },
    "price_cents": { "from": "Precio", "transform": "money" },
    "package_qty": { "from": "Contenido", "transform": "qty" },
    "unit": { "from": "Unidad", "transform": "unit" }
  },
  "options": { "date_format": "dd/mm/yyyy", "similarity_threshold": 0.7, "similar_policy": "skip" }
}
```

Transformaciones disponibles: `text` (recorta espacios), `money` (→ centavos; acepta `$`, comas, punto),
`qty` (número; `1.808` o `1,5`), `unit` (g, gr, kg, ml, l, lt, pz, pza, pieza, docena, lb, oz),
`phone` (deja 10 dígitos; quita espacios, guiones y `+52`), `date` (dd/mm/aaaa, aaaa-mm-dd, "12 de marzo de 2026"),
`bool` (sí/no, x, pagado/pendiente, 1/0), `int`.

Opciones útiles: `default_unit` (unidad cuando la columna viene vacía), `decimal_comma` (si usas coma decimal
siempre), `similar_policy: "create"` (crear aunque se parezca a algo existente; úsalo solo después de revisar),
`create_missing_customers` (pedidos: registrar clientes nuevos si traen teléfono/email; default `true`).

Campos aceptados por entidad: corre el importador con un campo inventado y el mensaje te lista los válidos, o
revisa `packages/db/scripts/import/entities/*.ts` (`fields`).

## Paso 2 · Orden recomendado

Cada entidad depende de la anterior; respeta este orden:

1. **ingredients** — crea ingredientes y su primer precio (precio ÷ contenido = costo por g/ml/pz).
2. **products** — crea productos, categorías por nombre y precio regular.
3. **recipes** — necesita que existan producto e ingredientes (si falta uno, esa receta completa se marca en error).
4. **prices** — solo si tienes una pestaña de precios distinta a la de productos (cierra el precio anterior y abre el nuevo).
5. **customers** — teléfono o email obligatorio (es la identidad del cliente).
6. **orders** — pedidos/ventas históricas: necesita productos (y clientes si quieres enlazarlos).

## Paso 3 · Simular

```bash
pnpm --filter @pdp/db run import -- \
  --file ~/Descargas/PanDePaula.xlsx --sheet Ingredientes \
  --entity ingredients --mapping packages/db/import/mappings/ingredientes.json
```

Salida en consola:

```
· Leídas 42 filas de PanDePaula.xlsx (hoja Ingredientes)

SIMULACIÓN · ingredients · batch 7c1e…
  se crean: 39 · se actualizan: 0 · ya existen: 0 · omitidas: 2 · errores: 1
  fila 17 [skipped] Posible duplicado: «Mantequila» se parece a «Mantequilla» (91%)…
  fila 30 [error] Falta la unidad (columna Unidad u options.default_unit)
  reporte: packages/db/import/reports/7c1e….md
  Para aplicar: repite el comando con --apply
```

## Paso 4 · Revisar el reporte

Abre `packages/db/import/reports/<batch>.md`. Tiene: resumen por acción, **filas que requieren atención**
(error/omitida con el motivo y los datos originales), advertencias y el detalle fila por fila.

| Acción       | Significado                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| Se crea      | No existía; se creará.                                                                                 |
| Se actualiza | Existía; se le agrega algo (nuevo precio, categoría faltante, líneas de receta cambiadas).             |
| Ya existe    | Coincide exactamente (nombre normalizado, teléfono, misma fila ya importada). No se toca.              |
| Omitida      | Se parece a algo existente, está repetida en el archivo o no tiene productos. **Decide tú.**           |
| Error        | Dato inválido o dependencia faltante. Se omite y el resto continúa (o todo se detiene con `--strict`). |

Corrige el archivo o el mapeo y vuelve a simular hasta que el resumen sea el que esperas.
Errores típicos: unidad vacía (agrega `default_unit`), producto/ingrediente que aún no existe (importa primero
la entidad previa), teléfono de 7 dígitos, total del pedido mayor a la suma de sus productos (revisa precios).

## Paso 5 · Aplicar

Mismo comando con `--apply` (y `--staff-email tu@correo` para que quede en auditoría quién importó):

```bash
pnpm --filter @pdp/db run import -- --file ~/Descargas/PanDePaula.xlsx --sheet Ingredientes \
  --entity ingredients --mapping packages/db/import/mappings/ingredientes.json --apply --staff-email admin@elpandepaula.mx
```

- Todo se escribe en **una transacción por entidad**. Cada fila (o receta, o pedido) va en su propio punto de
  guardado: si una falla, solo esa se omite y el resto se aplica.
- `--strict`: cualquier error revierte la corrida completa (útil para recetas y precios).
- En producción (`APP_ENV=production`) además exige `--yes-production`.
- Vuelve a correr el mismo archivo cuando quieras: verás "Ya existe" y cero creaciones.

## Paso 6 · Verificar en el CRM

| Entidad     | Dónde mirar                                                         | Qué comprobar                                                              |
| ----------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ingredients | `/ingredientes`                                                     | Unidad base correcta (g/ml/pz) y costo por unidad = precio ÷ contenido.    |
| products    | `/productos`, `/categorias`, `/precios`                             | Nombre, categoría, precio vigente. El sitio público solo muestra activos.  |
| recipes     | `/recetas`                                                          | Costo por pieza igual (±1 centavo) al de la hoja; sin "precios faltantes". |
| prices      | `/precios`                                                          | El precio anterior aparece cerrado y el nuevo vigente.                     |
| customers   | `/clientes`                                                         | Teléfono a 10 dígitos, origen "import".                                    |
| orders      | `/pedidos` (filtra por fecha), `/clientes` → historial, `/reportes` | Total, fecha y cliente. El **inventario no cambia** por ventas históricas. |

Qué hace exactamente una venta histórica (`import_historical_sale`): crea pedido + productos + venta + pago
con la fecha original, usa el precio de la hoja (o el vigente si no viene), actualiza el total comprado y el
número de compras del cliente, **no descuenta inventario ni otorga puntos** y emite `HISTORICAL_SALE_IMPORTED`.
Si la fila dice "no pagado", crea solo el pedido confirmado con pago pendiente.
Si el total de la hoja es menor a la suma de productos, la diferencia se guarda como descuento; si es mayor, la
fila se marca en error (no se inventan cargos).

## Si algo salió mal

- **Aplicaste con un mapeo equivocado**: no borres nada a mano. Identifica el batch en `import_batches`
  (o el reporte) y revisa `import_rows.target_id`. Productos/ingredientes/clientes creados de más se pueden
  desactivar desde el CRM; ventas históricas erróneas se anulan con "anular venta" (`void_sale`) para que quede
  el rastro. Si fue masivo, avisa al equipo técnico: se restaura desde respaldo (ver `BACKUP_RESTORE.md`).
- **Un nombre similar era realmente otro producto**: vuelve a correr solo esas filas con
  `"similar_policy": "create"` en el mapeo, o créalo en el CRM.
- **Dos clientes son la misma persona**: no lo resuelve el importador; se fusionan desde `/clientes`
  (campo `merged_into_id`), conservando el historial de ambos.

## Consultas útiles (para el equipo técnico)

```sql
-- Corridas recientes
select id, entity, status, total_rows, ok_rows, error_rows, created_at from import_batches order by created_at desc limit 20;
-- Filas con problema de un batch
select row_number, action, error, raw from import_rows where batch_id = '<batch>' and action in ('error','skipped') order by row_number;
-- Qué creó un batch
select target_entity, action, count(*) from import_rows where batch_id = '<batch>' group by 1, 2;
-- Ventas históricas importadas
select folio, placed_at, customer_name, total_cents from orders where source_ref like 'import:%' order by placed_at;
```
