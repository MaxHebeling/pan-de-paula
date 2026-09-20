# Portal del cliente (`/portal`)

El cliente entra a su propia cuenta en el sitio público para ver su nivel, sus puntos, su QR y todas
sus compras. **Lee exactamente las mismas tablas que el CRM**: no hay copias, ni caché, ni sincronización
manual. Una venta del POS o de la web aparece en el portal en cuanto la función SQL correspondiente la
registra.

## Mapa

| Ruta                      | Qué es                                                                                 | Sesión |
| ------------------------- | -------------------------------------------------------------------------------------- | ------ |
| `/portal/entrar`          | El cliente escribe su correo y pide un enlace de acceso                                | no     |
| `/portal/acceso?t=…`      | Canje del enlace (un botón, POST) → abre la sesión                                     | no     |
| `/portal`                 | Nivel con su color real, puntos, QR, código público, últimas compras                   | sí     |
| `/portal/perfil`          | Datos personales, código de cliente, fecha/hora de alta y canal de registro (`source`) | sí     |
| `/portal/compras`         | Historial de compras                                                                   | sí     |
| `/portal/compras/[folio]` | Detalle: productos, cantidades, precios, descuentos, total, pago, entrega y puntos     | sí     |
| `/portal/puntos`          | Saldo y movimientos del ledger                                                         | sí     |

Todo el portal es `noindex` (metadatos por página) y `/portal` está en `Disallow` de `robots.txt`.
`/mi-tarjeta/[token]` sigue existiendo igual que antes: es la tarjeta sin sesión, pensada para el QR.

## Autenticación

No hay contraseñas de cliente. La identidad se demuestra teniendo un **enlace de acceso de un solo uso**.
Es el mismo patrón que ya usa el staff para restablecer su contraseña, con las mismas garantías:

```
  /portal/entrar  →  customer_access_tokens (sha256 del token, 1 hora, un solo uso)
        ↓ el cliente abre el enlace y pulsa "Entrar a mi cuenta" (POST)
  /portal/acceso  →  customer_sessions (sha256 del token, 30 días, last_seen_at, revoked_at)
        ↓
  cookie httpOnly `pdp_cliente`  (sameSite=lax, secure en producción)
```

- El token en claro **solo** vive en el enlace. En la base está su sha256.
- Pedir un enlace nuevo invalida el anterior: solo sirve el último.
- El canje va en un **POST**, no en un GET: los clientes de correo y los antivirus "pre-visitan" los
  enlaces y con un GET el token se habría consumido antes de que el cliente tocara nada.
- El canje es atómico (`update … where used_at is null … returning`): dos peticiones simultáneas no
  pueden usar el mismo enlace.
- La sesión desliza su expiración, pero nunca más allá de 30 días desde que se creó.
- Cerrar sesión **revoca el token en la base**, no solo borra la cookie.

Código: `packages/auth/src/customer.ts` (también exportado como `@pdp/auth/customer`),
`apps/web/lib/portal/session.ts`.

### Privacidad de la pantalla de acceso

`/portal/entrar` responde **exactamente lo mismo exista o no la cuenta** ("Si ese correo tiene una
tarjeta, te enviamos un enlace"). Nunca se dice qué correos están registrados ni si el envío salió.
Hay rate limit por IP sobre la misma tabla `rate_limits` del resto del sitio (8 solicitudes por
ventana de 10 minutos; 12 para el canje).

### Mientras Resend no esté configurado

**Hoy en producción no hay proveedor de correo** (`RESEND_API_KEY` / `EMAIL_FROM` vacíos), así que el
enlace se genera pero no sale de la aplicación. Para que nadie se quede fuera de su cuenta, el CRM
puede generarlo a mano:

> Clientes → ficha del cliente → **Acceso a su cuenta en el sitio** → _Generar enlace de acceso_

Requiere el permiso `customers.write`, queda registrado en `audit_logs` como `CUSTOMER_ACCESS_LINK`
con el staff que lo generó, y el enlace se muestra una sola vez con un botón para copiarlo (no se
guarda en claro en ningún lado: si se pierde, se genera otro y el anterior deja de servir). Si algún
día el correo sí está configurado, la misma acción además se lo manda al cliente.

Cuando se configure Resend no hay que cambiar nada: `sendPortalAccessEmail` (en `@pdp/integrations`,
con el maquetado común del resto de los correos) empieza a enviar solo.

## Seguridad

- **Toda** consulta del portal recibe el `customer_id` de la sesión y filtra por él en SQL
  (`apps/web/lib/portal/data.ts`). Ningún dato que venga del cliente decide de quién son los datos.
- En las URLs nunca hay ids internos: se usan `public_code` y `folio`. El folio solo acota **dentro**
  de las compras del cliente de la sesión, así que el folio de otra persona simplemente no existe → 404.
- El layout `app/portal/(sesion)/layout.tsx` es la puerta única: ninguna página de esa sección puede
  quedarse sin comprobar la sesión por olvido.
- No se expone nada interno: ni costos, ni márgenes, ni `internal_notes`, ni la nota del staff en los
  ajustes de puntos (los conceptos del ledger se traducen desde `kind`).
- Cookies `httpOnly`, `sameSite=lax`, `secure` en producción, con expiración.
- Respeta la CSP existente: sin `eval`, sin CDNs nuevas, sin dependencias nuevas.

## De dónde sale cada cosa

| En el portal           | Origen                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| Nivel, puntos, totales | `customers` (las mismas columnas que lee el CRM)                               |
| Color del nivel        | `loyalty_tiers.color` (gray / blue / amber / green)                            |
| QR y código            | `customers.qr_token` y `customers.public_code`, con `qrDataUrl` + `cardUrl`    |
| Compras                | `sales` + `orders` (+ `order_items` en el detalle); las anuladas se **marcan** |
| Pago                   | `payments` (métodos en estado `paid` / `partial` / `authorized`)               |
| Puntos ganados         | `loyalty_transactions` filtradas por `sale_id`                                 |
| Movimientos de puntos  | `loyalty_transactions` del cliente                                             |
| Canal de registro      | `customers.source`                                                             |

El sistema **no guarda** en qué sucursal se dio de alta un cliente, así que el perfil no muestra nada
al respecto: preferimos no enseñar un dato antes que inventarlo.

## Datos obligatorios en las altas humanas

Desde la migración `0045`, `register_customer` **exige nombre, celular, correo y fecha de nacimiento**.
Antes (`0043`) solo exigía nombre y correo. El correo es la llave del portal; de la fecha de nacimiento
sale el cumpleaños.

**Una sola fecha.** Se guarda `customers.birthday` (fecha de nacimiento). El día y el mes del festejo
se derivan de ella con `observed_birthday` / `celebrates_birthday_on` (migración `0042`, que también
resuelve el 29 de febrero). No existe —ni debe existir— una segunda "fecha de cumpleaños".

**Dónde vive la regla.** En la función SQL, no en las pantallas: así la cumplen por igual el mostrador,
el sitio y el CRM, y nadie puede saltársela desde su propia capa. Los formularios la repiten
(`customerRegistrationCompleteSchema` en `@pdp/domain`) solo para dar el mensaje correcto antes de
llegar a la base.

**Por qué no hay `not null` en la tabla.** Los clientes históricos existen y tienen huecos. Ponerles un
`not null` obligaría a inventarles datos o a romperlos. La obligatoriedad aplica a lo NUEVO; lo viejo se
conserva y se completa.

| Alta                                        | Qué pide ahora                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/unete` del sitio                          | Los cuatro datos                                                                                                                       |
| Alta de cliente del CRM (`/clientes/nuevo`) | Los cuatro datos, y al guardar se le prepara y envía su enlace del portal                                                              |
| Alta del POS (`/api/pos/customers`)         | Los cuatro datos. Si el cliente no los quiere dar **se cobra sin asignarle cuenta**: la venta nunca se frena                           |
| Checkout web (`/checkout`)                  | Solo si marca "quiero novedades": entonces se le piden correo y fecha. Si no los da, el **pedido se crea igual** y no se le da de alta |
| Importación histórica y seeds               | Excepción documentada `allow_incomplete: true` (alias antiguo `allow_without_email`)                                                   |

Una fecha de nacimiento futura o anterior a 1900 se rechaza **siempre**, también con la excepción: eso
no es un cliente incompleto, es un error de captura.

### Clientes históricos incompletos

Se conservan intactos: datos, puntos, QR, código público e historial. Y no se les bloquea nada.

- El CRM muestra en su ficha un aviso de **"Datos pendientes: correo, celular, fecha de nacimiento"**
  (lo que falte) y se pueden capturar en "Editar", donde esos campos NO son obligatorios salvo que el
  cliente ya los tuviera — un dato existente no se puede borrar.
- El propio cliente puede completarlos desde `/portal/perfil`, que solo muestra los campos que faltan
  (`completePortalProfileAction`). Ese formulario **solo rellena huecos**: corregir un dato ya
  capturado se pide al equipo, para que quede en la auditoría del CRM.
- Volver a pasar por `register_customer` con el mismo teléfono o correo **completa** el registro
  existente y devuelve `created: false`. Nunca se crea un duplicado.
- `customer_missing_fields(uuid)` dice qué le falta a un cliente, y es lo que usan ambas pantallas.

### Cambiar el correo de quien ya tiene portal

El correo es la llave de acceso. Al cambiarlo desde el CRM, el cliente **sigue siendo el mismo registro**
(mismo historial, puntos, código y QR), pero se anulan sus enlaces de acceso pendientes y se revocan sus
sesiones abiertas, y queda un `CUSTOMER_PORTAL_ACCESS_RESET` en `audit_logs`. El CRM lo avisa en pantalla
para que se le mande un enlace nuevo. Sin esto, quien tuviera el correo anterior seguiría dentro.

## Mis pedidos, en vivo

El portal muestra los pedidos del cliente **mientras están vivos** (`/portal/pedidos`), con su línea
de tiempo, y los avisos que genera cada cambio. `/portal/compras` sigue siendo otra cosa: las ventas
ya cerradas.

### De dónde sale el estado

Una sola fuente de verdad: la tabla `orders` que ya usa el CRM. El portal no guarda copias ni estados
propios. La línea de tiempo (`portalTimeline` en `@pdp/domain`) **lee** los estados existentes y los
agrupa en los cinco hitos que le importan a una persona:

```
  received      new · payment_pending
  confirmed     confirmed · paid
  preparing     in_production
  ready         ready · ready_for_pickup · out_for_delivery   ("En camino" si es a domicilio)
  done          delivered · completed
```

Las horas salen de `order_status_history`, que guarda **cada** cambio y nunca sobrescribe el
anterior. Un pedido cancelado o reembolsado deja de avanzar: se muestra hasta dónde llegó y se dice
que está cancelado, en vez de fingir que sigue en curso.

### Por qué no hay Supabase Realtime

Esta app habla con Postgres con su **propio rol** (`pdp_app`) por el pooler en modo transacción, y el
portal tiene **sesión propia por cookie**, no Supabase Auth. Realtime exigiría exponer la clave
anónima en el navegador y atar las políticas a usuarios de Supabase: un segundo sistema de identidad
y una superficie pública que la migración `0080` cierra a propósito. Tampoco sirve `LISTEN/NOTIFY`:
el pooler en modo transacción no mantiene la conexión.

En su lugar se usa el mismo patrón que ya tiene el contador de pedidos sin ver del CRM: `LiveOrders`
sondea `GET /api/portal/pulso` cada 10 s **solo con la pestaña visible**, y cuando algo cambió pide a
Next que vuelva a renderizar en el servidor (`router.refresh()`). Así los datos siguen saliendo de
las mismas consultas filtradas por sesión y no hay una segunda copia del estado en el navegador. Un
solo temporizador, se detiene al ocultar la pestaña y se limpia al desmontar. Si la red falla se
avisa ("Sin conexión…") en vez de enseñar un estado viejo como si fuera el de ahora.

### Avisos

Los genera la base, no la aplicación: un disparador sobre `order_status_history` (migración `0046`)
escribe en `customer_notifications`. Como `status_history_id` es **único**, una misma transición no
puede avisar dos veces aunque la operación se repita. Los textos viven en una sola función SQL
(`customer_notification_text`), así que el portal —y el push, cuando exista— dicen exactamente lo
mismo sin copiar frases por el código.

No se avisa de: pedidos sin cliente identificado (mostrador anónimo), estados contables (`new`,
`paid`, `completed`) ni cambios con fecha vieja (la importación histórica escribe historial con la
fecha de la venta original; nadie quiere recibir hoy el aviso de un pedido de hace un año).

Abrir el seguimiento marca como leídos los avisos de ese pedido. Se hace al montar la página y no en
el render, porque Next precarga los enlaces y marcaría avisos que el cliente nunca abrió.

### Cómo queda vinculado el pedido

Por orden de fiabilidad, nunca por el nombre (hay homónimos):

1. la **sesión del portal** — si compró con su cuenta abierta, es él;
2. el vínculo explícito "ya soy cliente" (código, teléfono o correo que escribió);
3. el teléfono del pedido;
4. en el CRM, el buscador de cliente del pedido manual (código, teléfono, correo o nombre) — la
   persona elige, el sistema no adivina.

Da igual por dónde entre el pedido (sitio, portal, teléfono, mostrador): es el mismo `orders` y el
mismo `customer_id`, así que aparece en su portal sin que nadie lo vincule a mano.

## Pruebas

| Archivo                                              | Qué cubre                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/test/customer_portal.test.ts`           | Correo obligatorio y su excepción, normalización, unicidad, cliente histórico que recibe correo sin duplicarse, tokens (un solo uso, caducidad, hash), sesiones, y no regresión de `pos_checkout`/`finalize_sale`/ledger |
| `apps/web/test/portal.test.ts`                       | Respuesta idéntica exista o no la cuenta, canje de un solo uso, sesión y su caducidad/revocación, acceso denegado sin sesión, aislamiento de todas las consultas por cliente                                             |
| `apps/web/e2e/portal.spec.ts`                        | Flujo completo en el navegador, compra ajena → 404, `/mi-tarjeta/[token]` intacto, cliente histórico que completa sus datos desde su portal                                                                              |
| `packages/db/test/customer_required_fields.test.ts`  | La regla de 0045 en SQL: qué se rechaza, fechas imposibles, la excepción de importación, y que el histórico se completa sin duplicarse conservando código, QR, puntos y compras                                          |
| `packages/domain/test/customer_registration.test.ts` | El espejo en el formulario: mensajes por campo, normalización de correo y teléfono, fechas inválidas                                                                                                                     |
| `apps/admin/e2e/registro-obligatorio.spec.ts`        | El CRM en el navegador: campos obligatorios, rechazo del servidor, enlace de portal creado en el alta, aviso de datos pendientes y revocación de acceso al cambiar el correo                                             |
| `packages/db/test/customer_notifications.test.ts`    | Los avisos cuelgan del historial: uno por transición, imposible duplicarlos, ninguno para pedidos sin cliente, ninguno cruzado entre clientes, ninguno por importación histórica                                         |
| `packages/domain/test/portal_timeline.test.ts`       | Cada estado cae en su hito, la hora sale de la primera vez que pasó por ahí, el pedido cancelado deja de avanzar                                                                                                         |
| `apps/web/e2e/pedidos-vivo.spec.ts`                  | El flujo completo en el navegador: el pedido aparece, el CRM lo mueve y el portal se actualiza sin recargar, con aviso, campana y línea de tiempo; y el pedido ajeno da 404                                              |
