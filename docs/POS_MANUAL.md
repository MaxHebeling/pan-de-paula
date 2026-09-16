# Manual del Punto de Venta (POS)

> Para quien atiende el mostrador. Ruta en el CRM: **`/pos`** (permiso `pos.sell`) y **`/caja`** (permiso
> `pos.register`). Pensado para tablet: botones grandes, 2–3 toques por venta.
>
> **Aviso:** las pantallas del CRM se están construyendo en paralelo por módulos. Este manual describe cómo
> funciona cada una según la arquitectura y las reglas de negocio ya implementadas en la base de datos; si una
> pantalla todavía no aparece en tu menú, es que ese módulo aún no se publicó. Lo que el sistema garantiza
> (una venta = pedido + pago + inventario + puntos en una sola operación) ya existe y está probado.

## Antes de vender: abrir caja (`/caja`)

1. Entra con tu usuario. Si no ves "Caja" en el menú, tu rol no tiene permiso `pos.register`.
2. **Abrir caja**: cuenta el efectivo inicial (fondo) y captúralo. Solo puede haber **una caja abierta a la vez**;
   si alguien la dejó abierta ayer, ciérrala primero (el sistema lo exige).
3. La pantalla muestra: efectivo esperado, ventas por método, y el botón de cierre.

## Vender (`/pos`)

1. **Elige productos**: por categoría o buscador; los favoritos (`pos_favorite`) aparecen primero. Un toque agrega
   una pieza; toca la cantidad para cambiarla. Los productos sin precio o inactivos no aparecen.
2. **Cliente (opcional pero recomendado)**: escanea su QR, o escribe su código `PDP-000123`, teléfono o email.
   Si es nuevo: "Registrar" con nombre + teléfono (30 segundos). Con cliente asignado se acumulan puntos.
   El teléfono trae selector de país (México por defecto); a un cliente extranjero se le busca con o sin `+`.
3. **Descuentos**: por línea (cantidad fija) o cupón (código). El sistema valida vigencia, canal, mínimo y usos;
   si no aplica te dice el motivo (`expirado`, `mínimo de compra`, `ya usado`…).
4. **Recompensa**: si el cliente tiene un canje emitido, selecciónalo y el descuento se aplica.
5. **Cobrar**: elige método.
   - **Efectivo**: captura lo recibido; el sistema calcula el cambio. No acepta menos que el total.
   - **Terminal / Mercado Pago Point / QR**: si el flag está activo, se dispara el cobro y se espera confirmación.
   - **Transferencia**: captura la referencia.
   - Se pueden combinar métodos (pago parcial + efectivo); la venta se cierra cuando la suma llega al total.
     Un pago que exceda el total se rechaza.
6. **Confirmación**: folio `PDP-2026-000123`, cambio y puntos ganados. Imprime o envía el comprobante.

Qué pasa por dentro en ese toque (todo o nada; si algo falla no queda una venta a medias): se crea el pedido con
precio del servidor, se registra el pago, se genera la venta, se descuenta inventario, se otorgan puntos, se
registra el cupón y se emiten avisos de stock bajo.

## Precios y promociones

El POS toma el precio **vigente para el canal `pos`** (o el general). Una promo con fecha se aplica sola; no
hay que cambiar nada en caja. Si un producto muestra "sin precio", avisa a quien administra `/precios`.

## Inventario en caja

- Cada venta descuenta stock del producto. Si el negocio tiene "permitir stock negativo" apagado, el POS
  bloquea la venta cuando no hay piezas: verifica con producción antes de forzar nada.
- Regalos/cortesías **no se venden a $0**: se registran como merma con motivo `gift`/`courtesy` desde inventario,
  para que el costo quede bien.

## Anulaciones, devoluciones y reembolsos (permiso `pos.refund`)

| Situación                              | Acción                                       | Efecto                                                                               |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Te equivocaste y el cliente sigue aquí | **Anular venta** (motivo)                    | La venta queda anulada (no se borra), el inventario regresa, los puntos se revierten |
| Devuelven producto                     | **Devolución** (con o sin reingreso a stock) | Registro físico; si reingresa, vuelve al inventario                                  |
| Hay que regresar dinero                | **Reembolso** (monto, motivo)                | Registro financiero sobre el pago original; MP se reembolsa por API si aplica        |

Todo queda en auditoría con tu usuario.

## Cerrar caja (`/caja`)

1. Cuenta el efectivo físico y captúralo. El sistema compara contra lo esperado
   (fondo + efectivo cobrado − reembolsos en efectivo) y muestra la **diferencia**.
2. Anota una nota si hay diferencia. Cierra. El reporte del turno queda en `/reportes`.

## Si algo falla

- "La caja no está abierta": abre caja en `/caja`.
- "Stock insuficiente": pide a producción que registre lo horneado en `/produccion`.
- "Cupón inválido: …": el motivo viene en el mensaje; no se puede forzar.
- Pantalla sin respuesta: recarga; si `/api/ready` marca error, sigue el runbook "No se puede vender en POS"
  de `INCIDENT_RESPONSE.md` y **anota las ventas en papel** con hora, productos y método para capturarlas después.
- Nunca vendas "por fuera" del sistema para no perder puntos del cliente ni cuadre de inventario.

## Buenas prácticas

- Registra al cliente **antes** de cobrar (los puntos no se agregan después).
- Un solo usuario por turno; no compartas sesión.
- Cierra caja todos los días aunque no haya diferencia.
