# Conectar Instagram al CRM

Estado al 10 de octubre de 2026: **el bot de mensajes directos está construido, probado y
desplegado, pero dormido.** Le faltan credenciales de Meta. Los comentarios y las métricas aún no
están construidos.

Lo que ya existe en el repositorio:

| Pieza | Dónde | Estado |
|---|---|---|
| Firma, webhook, envío, bot de reglas, IA opcional | `packages/integrations/src/instagram.ts` (886 líneas) | Hecho, 21 pruebas |
| Endpoint del webhook | `apps/web/app/api/webhooks/instagram/route.ts` | Desplegado |
| Tubería idempotente + reintentos | `apps/web/lib/webhooks/instagram.ts` | Hecho, 8 pruebas |
| Tablas | `instagram_conversations`, `instagram_messages`, `leads`, `webhook_events` | En producción |
| Bandeja en el CRM | `apps/admin/app/(app)/instagram/` | Hecha: filtros, búsqueda, métricas, leads |
| Credenciales | — | **Faltan todas** |
| Flags `instagram_bot`, `instagram_ai_replies` | `feature_flags` | Apagados |

Comprobado en vivo: el webhook responde `403` al challenge (sin token de verificación) y `500` al
POST (sin `META_APP_SECRET`, que en producción rechaza a propósito). Se comporta exactamente como
debe estando sin configurar.

## Decisión previa: qué camino de inicio de sesión

Meta ofrece dos y **cambian los nombres de los permisos**. No se pueden mezclar.

| | **Instagram Login** (recomendado) | Facebook Login |
|---|---|---|
| Endpoint | `graph.instagram.com` | `graph.facebook.com` |
| ¿Exige Página de Facebook? | No | Sí, con la cuenta IG vinculada |
| Permiso base | `instagram_business_basic` | `instagram_basic` + `pages_read_engagement` |
| Mensajes | `instagram_business_manage_messages` | `pages_messaging` |
| Comentarios | `instagram_business_manage_comments` | `instagram_manage_comments` |
| Métricas | `instagram_business_manage_insights` | `instagram_manage_insights` |
| `total_comments`, `total_likes`, `total_views` agregados | **No disponibles** | Disponibles |

**Recomendación: Instagram Login.** No hace falta Página de Facebook (hoy el negocio no tiene
ninguna) y es lo que el código ya trae por defecto en `INSTAGRAM_API_BASE_DEFAULT`. Lo único que
se pierde son tres métricas agregadas que no valen el coste de montar y mantener una Página.

Los valores antiguos (`business_basic`, `business_manage_messages`, `business_manage_comments`)
quedaron **obsoletos el 27 de enero de 2025**. Si algún tutorial los menciona, está viejo.

## Requisito que no se negocia

La cuenta `@el.pandepaula` debe ser **cuenta profesional** (Empresa o Creador). Con cuenta
personal no hay API, punto. Se cambia desde la app: Configuración → Tipo de cuenta.

## Pasos en Meta (los hace Max; no se pueden hacer desde aquí)

1. **Cuenta profesional.** Confirmar que `@el.pandepaula` es Empresa o Creador.

2. **Crear la app** en [developers.facebook.com](https://developers.facebook.com) → Mis Apps →
   Crear app → caso de uso **"Otro"** → tipo **Empresa**. Añadir el producto **Instagram**.

3. **Configurar el inicio de sesión de empresa de Instagram** y pedir estos alcances:
   ```
   instagram_business_basic
   instagram_business_manage_messages
   instagram_business_manage_comments
   instagram_business_manage_insights
   ```
   `instagram_business_basic` es obligatorio: sin él no se puede ni refrescar el token.

4. **Anotar del panel de la app:**
   - `App secret` → va a `META_APP_SECRET`
   - El **ID de la cuenta de Instagram** → `INSTAGRAM_ACCOUNT_ID`

5. **Generar el token.** El flujo devuelve un token de corta duración; hay que **canjearlo por uno
   de larga duración (60 días)**. Ese es el que va a `INSTAGRAM_PAGE_ACCESS_TOKEN`.
   Ver el aviso de los 60 días más abajo: es importante.

6. **Inventar un token de verificación** propio (una cadena larga y aleatoria, la que sea) → va a
   `META_VERIFY_TOKEN`. Es solo un secreto compartido para que Meta pruebe que el webhook es
   nuestro.

7. **Dar de alta el webhook** en el panel, producto Instagram → Webhooks:
   - URL de devolución de llamada: `https://www.pandepaula.com/api/webhooks/instagram`
   - Token de verificación: el del paso 6
   - Meta hará un `GET` al guardar. Si devuelve `403`, el token no coincide.
   - **Suscribirse a los campos:** `messages` (para los DMs) y, cuando se construyan,
     `comments` y `mentions`. Los campos se eligen en el panel; no se pueden suscribir por API.

8. **Revisión de la app (App Review).** Es el paso largo y el verdadero cuello de botella.
   Mientras la app esté en **modo desarrollo**, el bot solo puede hablar con cuentas que tengan un
   rol en la app. Para contestar a clientes reales hace falta **acceso avanzado**, y eso pasa por
   revisión. Hay que grabar un vídeo mostrando el flujo y explicar el uso.

   Ojo con la trampa clásica: en modo desarrollo todo *parece* funcionar porque tú sí recibes
   respuesta — eres administrador de la app. Un cliente cualquiera no recibe nada y no hay error
   visible en ninguna parte.

## Variables a poner en Vercel (proyecto `pan-de-paula-web`)

El webhook vive en la app web, no en el CRM. Los nombres los exige
`apps/web/lib/env.ts` y son estos exactamente:

| Variable | De dónde sale | ¿Obligatoria? |
|---|---|---|
| `META_APP_SECRET` | App secret del panel | Sí: sin ella el webhook devuelve 500 en producción |
| `META_VERIFY_TOKEN` | La cadena que inventes (paso 6) | Sí: sin ella el challenge da 403 |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | Token de larga duración (paso 5) | Sí, para poder responder |
| `INSTAGRAM_ACCOUNT_ID` | ID de la cuenta IG | Sí |
| `INSTAGRAM_API_BASE` | Solo si se usa Facebook Login | No |
| `ANTHROPIC_API_KEY` | Consola de Anthropic | Solo para respuestas con IA |

Recordatorio de este proyecto: en `vercel env add` usar `printf`, no `echo`, y **`env rm` borra la
variable de TODOS los entornos**.

## Encender, en este orden

1. Variables en Vercel + redespliegue (las variables no se aplican a un despliegue ya hecho).
2. Comprobar que el challenge pasa:
   ```bash
   curl -s "https://www.pandepaula.com/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=EL_TOKEN&hub.challenge=12345"
   # debe imprimir: 12345
   ```
3. Mandarse un DM a la cuenta desde **otra** cuenta que tenga rol en la app y comprobar que
   aparece en `crm.pandepaula.com/instagram`.
4. Solo entonces encender el flag `instagram_bot`.
5. `instagram_ai_replies` al final, y solo con `ANTHROPIC_API_KEY` puesta. Con el flag de IA
   encendido y sin clave, el bot cae a las respuestas de reglas; no se rompe, pero tampoco usa IA.

El orden importa: encender el flag antes de verificar que llegan los mensajes deja un bot que
contesta a nadie, y no hay forma de notarlo desde el CRM.

## Aviso: el token caduca cada 60 días

**Esto va a tumbar la integración en silencio dos meses después de encenderla.**

El token de larga duración de Instagram vive **60 días**. Hay un endpoint para refrescarlo (exige
`instagram_business_basic`), pero hoy el código lee `INSTAGRAM_PAGE_ACCESS_TOKEN` como variable de
entorno fija: **no hay ningún mecanismo de refresco**. Cuando caduque, `sendInstagramMessage`
empezará a fallar y los mensajes seguirán entrando y guardándose, así que la bandeja del CRM se
verá normal mientras ningún cliente recibe respuesta.

Hay que resolverlo antes de depender del bot. Dos opciones:

- **Recordatorio en el calendario cada 50 días** para regenerar el token a mano. Funciona, es
  frágil, y depende de que alguien se acuerde.
- **Cron de refresco** (lo correcto): guardar el token en base en lugar de en el entorno, un cron
  semanal que lo refresque y lo reescriba, y un latido a HEBELING CORE si falla. El proyecto ya
  tiene la infraestructura: `vercel.json` corre crons cada 15 minutos y el flujo de respaldo ya
  manda latidos.

Mientras no exista el refresco, conviene además una alerta: si `sendInstagramMessage` falla por
token inválido, que abra incidencia en vez de quedarse en el registro.

## Pendiente de construir

| Qué | Permiso | Notas |
|---|---|---|
| **Comentarios**: recoger y responder | `instagram_business_manage_comments` | `parseInstagramWebhook` hoy solo lee `entry.messaging`; los comentarios llegan en `entry.changes[]` con `field: "comments"` y **se descartan en silencio**. Hay que extender el parser, añadir `POST /{ig-comment-id}/replies`, tabla, flag y pantalla. |
| **Métricas**: alcance y seguidores | `instagram_business_manage_insights` | Cuidado con los nombres: **`impressions` se eliminó el 21 de abril de 2025** y lo reemplazó `views`. También cayeron `video_views`, `profile_views`, `website_clicks` y `phone_call_clicks`. Implementar esos nombres es escribir código muerto. |

Dependencia de las métricas: **`follower_count` y `online_followers` solo funcionan con 100 o más
seguidores.** Si `@el.pandepaula` no llega, esas dos métricas no existen y el panel debe
contemplarlo en vez de mostrar cero.

## Fuentes

- [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)
- [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Webhooks de Instagram](https://developers.facebook.com/docs/instagram-platform/webhooks)
- [Referencia de webhooks: Instagram](https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram)
- [Insights](https://developers.facebook.com/docs/instagram-platform/insights/)
- [Comentarios](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/)
- [Baja de métricas de insights, 21 de abril de 2025](https://docs.emplifi.io/platform/latest/home/instagram-insights-metrics-deprecation-april-2025)
