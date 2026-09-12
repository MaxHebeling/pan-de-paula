# Manual de Producción e Inventario

> Para el equipo de cocina/horneado. Rutas: **`/produccion`** (permiso `production.write`) e **`/inventario`**
> (permiso `inventory.write`). Consulta: **`/recetas`** e **`/ingredientes`** (permiso `recipes.read`).
>
> **Aviso:** las pantallas se están construyendo en paralelo por módulos; este manual describe lo que hace cada
> una según las reglas ya implementadas en la base (registro de producción, mermas, conteos, costeo). Si una ruta
> aún no aparece en tu menú, ese módulo no se ha publicado todavía.

## La idea

El inventario **no se edita a mano**: se mueve con registros (producción entra, venta sale, merma sale,
corrección ajusta). Cada movimiento queda guardado para siempre; el número que ves es la suma de todos.
Así siempre se puede explicar por qué hay 14 croissants y no 20.

## Producción diaria (`/produccion`)

1. Abre el día: verás la **sugerencia de producción** (pedidos programados para hoy + faltante para llegar al
   mínimo de stock). Es orientativa.
2. Al sacar una tanda del horno: elige producto → cantidad → **Registrar producción**. Se crea un lote
   (`L260912-A1F3`) y las piezas entran al inventario al instante.
3. Notas opcionales (horno, quién horneó). Si el negocio activa "consumo de ingredientes", el sistema también
   descuenta harina, mantequilla, etc. según la receta (flag `ingredient_consumption`).
4. Puedes registrar varias tandas del mismo producto; no acumules: registra cada horneada cuando salga.

**Corrige errores con un movimiento contrario**, no borrando: si registraste 24 y eran 12, registra una merma
con motivo `error` por 12 (o una corrección desde inventario). Queda el rastro.

## Mermas (`/inventario` → Merma)

Cada pieza que no se vende se registra con motivo: `burnt` (quemado), `broken` (roto), `expired` (caducado),
`tasting` (degustación), `gift` (regalo), `courtesy` (cortesía), `internal_use` (consumo interno), `error`,
`difference` (diferencia de conteo), `other`. El sistema guarda el **costo** de esa merma con la receta vigente
para que el reporte de rentabilidad sea real.

## Conteo físico (`/inventario` → Conteo)

Recomendado al cierre del día o al menos semanal:

1. **Iniciar conteo**: el sistema propone la lista con la cantidad que "debería" haber.
2. Captura lo que **realmente** contaste por producto.
3. **Aplicar conteo**: las diferencias se registran como `CORRECTION` (positivas o negativas) y el stock queda
   igual a la realidad. Si prefieres no aplicar, "descartar" no toca nada.

Después del conteo, `/reportes` → Conciliación muestra: apertura + producción − ventas − mermas ± correcciones,
para cada producto y periodo. Diferencias grandes repetidas = revisar proceso (ventas sin registrar, mermas sin capturar).

## Alertas de stock

Cuando una venta deja un producto por debajo del **umbral de stock bajo** (configurable) o en cero, aparece un
aviso en `/notificaciones` y en el dashboard (`Stock bajo` / `Producto agotado`). Registrar producción cierra la alerta.

## Ingredientes y recetas (`/ingredientes`, `/recetas`)

- **Ingrediente** = nombre + unidad base (g, ml o pz) + **historial de precios** (precio del paquete y contenido).
  Al capturar una compra nueva ("Mantequilla, barra 1.808 kg, $400"), el costo por gramo se recalcula solo.
- **Receta** = producto + ingredientes con cantidades en unidad base + rendimiento (piezas por lote).
  El sistema calcula: costo de ingredientes → + mano de obra/indirectos por lote → ÷ rendimiento = **costo por pieza**,
  y el **margen** contra el precio de venta. Si falta el precio de un ingrediente, la receta marca "precios faltantes".
- Cambiar un precio de insumo hoy **no altera** las ventas pasadas (cada venta guardó su costo).
- Stock de insumos: entradas por compra, salidas por consumo de producción (si el flag está activo) o merma.

## Rutina sugerida

| Momento        | Acción                                                              |
| -------------- | ------------------------------------------------------------------- |
| Al llegar      | Revisar sugerencia de producción y pedidos programados (`/pedidos`) |
| Cada horneada  | Registrar producción                                                |
| Durante el día | Registrar mermas al momento (no al final de memoria)                |
| Al cierre      | Conteo físico rápido de lo que queda; aplicar                       |
| Semanal        | Capturar precios nuevos de insumos; revisar márgenes en `/recetas`  |

## Si algo falla

- "Stock no cuadra": sigue el runbook en `INCIDENT_RESPONSE.md` (conciliación → conteo → corrección).
- No puedes registrar producción: verifica tu permiso (`production.write`) y que el producto esté activo.
- Anota en papel hora, producto y cantidad si el sistema no responde; captúralo después con la fecha correcta
  (el registro de producción acepta fecha/hora real).
