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

## Correo obligatorio en las altas humanas

Desde la migración `0043`, `register_customer` **exige correo**, porque es la llave del portal.

- Lo exigen: `/unete` del sitio y el alta/edición de cliente en el CRM (validado en cliente y en
  servidor, normalizado a minúsculas y sin espacios, único por el índice `customers_email_idx` que ya
  existía; el `23505` se traduce a "Ese correo ya está registrado").
- Excepción documentada `allow_without_email: true`, para flujos donde lo que se está capturando **no**
  es un alta del club y bloquearlos costaría ventas:

| Quién                                      | Por qué                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| Alta rápida del POS (`/api/pos/customers`) | Mostrador con fila; el panel sí ofrece el campo de correo (opcional) |
| Pedido manual del CRM con cliente nuevo    | Se está capturando un pedido, no un alta del club                    |
| Checkout web (`/checkout`)                 | El correo es opcional en el pedido                                   |
| Importación histórica y seeds              | Los clientes del Sheets llegaron sin correo                          |

**Los clientes históricos sin correo se conservan intactos**: datos, puntos, QR, código e historial.
Cuando se les registra el correo (desde el CRM, o volviendo a pasar por `register_customer` con el
mismo teléfono) se **completa** el registro existente — no se crea un duplicado ni se toca nada más.
Sin correo no pueden pedirse el enlace solos; el CRM se los genera.

## Pruebas

| Archivo                                    | Qué cubre                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/test/customer_portal.test.ts` | Correo obligatorio y su excepción, normalización, unicidad, cliente histórico que recibe correo sin duplicarse, tokens (un solo uso, caducidad, hash), sesiones, y no regresión de `pos_checkout`/`finalize_sale`/ledger |
| `apps/web/test/portal.test.ts`             | Respuesta idéntica exista o no la cuenta, canje de un solo uso, sesión y su caducidad/revocación, acceso denegado sin sesión, aislamiento de todas las consultas por cliente                                             |
| `apps/web/e2e/portal.spec.ts`              | Flujo completo en el navegador, compra ajena → 404, `/mi-tarjeta/[token]` intacto                                                                                                                                        |
