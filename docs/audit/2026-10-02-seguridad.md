# Auditoría de seguridad · 2026-10-02

Blindaje del repositorio, el sitio y el CRM. Complementa la auditoría funcional del
[2026-09-22](2026-09-22.md); aquí el eje es seguridad, anti-clonación y mínimo privilegio.

Todo lo que se afirma abajo se comprobó ejecutándolo. Donde no se pudo comprobar, se dice.

## Resumen

El sistema entró a esta auditoría mejor defendido de lo que el prompt de partida suponía: RLS en las 70
tablas, PostgREST cerrado, rutas con autorización server-side, CSRF por `Origin` en todas las
mutaciones, tokens de 192–256 bits, subidas validadas por firma de bytes, plantillas que escapan todo.
Varias de las vulnerabilidades que se buscaron **no existen**, y eso se dejó demostrado con pruebas en
vez de con una conclusión.

Lo que sí había: un **aviso crítico de Next corriendo en producción**, controles de GitHub apagados
que son gratis en un repositorio público, un hueco en la comprobación CSRF cuando no llega `Origin`,
el **registro de Supabase Auth abierto** en un proyecto que no usa Supabase Auth, y secretos
compartidos entre ambientes — incluido uno que no protege nada.

Y un hallazgo sobre el propio trabajo: el primer control nuevo que escribí (buscar secretos en el
bundle del navegador) **decía ✓ estando ciego**. Lo descubrió su propia prueba negativa.

## Lo que se comprobó y está bien

| Qué                                                 | Cómo se comprobó                                                                        | Resultado                                                                                                                                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La clave pública de Supabase no lee la base         | 10 tablas por `/rest/v1/` con la clave `anon` real                                      | `42501 permission denied` en todas                                                                                                                                                                                        |
| Ninguna función de negocio es ejecutable por `anon` | `has_function_privilege` sobre las 160 funciones                                        | 0 de negocio; las 78 expuestas son de extensiones (`citext`, `pg_trgm`, `pgcrypto`), que concede Supabase y el rol migrador no puede revocar                                                                              |
| RLS                                                 | `pg_class.relrowsecurity` en las 70 tablas                                              | 70/70 con RLS, 0 tablas legibles por `anon`/`authenticated`                                                                                                                                                               |
| Rutas API con autorización                          | las 26 rutas, una por una                                                               | todas con `apiSession`/`getSession`+`hasPermission`, `isCronAuthorized` o verificación de firma; las 4 "sin guarda" son `health`/`ready` (públicas a propósito)                                                           |
| Las previews de Vercel no son públicas              | `curl` a previews de ambas apps                                                         | 302 a `vercel.com/sso-api`: Deployment Protection activo                                                                                                                                                                  |
| Secretos en el historial de git                     | 290 commits con patrones de credencial + GitHub secret scanning sobre todo el historial | 0 reales. Las coincidencias son fixtures: un token con el prefijo de Mercado Pago seguido de dígitos consecutivos, que existe precisamente para **probar** que la redacción lo tapa, y la URL del Postgres local de la CI |
| Secretos en el bundle del navegador                 | 86 chunks de cliente contra 21 valores reales de `.env.production`                      | ninguno                                                                                                                                                                                                                   |
| Cabeceras de seguridad                              | 24 aserciones contra producción                                                         | CSP, HSTS 2 años, `nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, sin `X-Powered-By`                                                                                                                          |
| Plantillas de correo y recibos                      | `escapeHtml`/`safeUrl` en todas las interpolaciones                                     | el nombre del cliente llega escapado al recibo que abre el CRM                                                                                                                                                            |
| Subidas de imagen                                   | `storage.ts`                                                                            | allowlist de 4 tipos, tope de 5 MB, y el tipo real se deduce de los **bytes** y debe coincidir con el declarado; SVG no se acepta                                                                                         |
| SSRF                                                | todos los `fetch(` con variable                                                         | ninguno con URL del usuario                                                                                                                                                                                               |
| Ejecución de comandos                               | `exec`/`spawn`/`child_process`                                                          | solo `RegExp.exec` y un `execFileSync` en un script de desarrollo                                                                                                                                                         |
| Fuerza bruta en el login                            | `packages/auth/src/session.ts`                                                          | bloqueo a los 5 intentos por cuenta (15 min) + límite por IP + hash señuelo para igualar tiempos                                                                                                                          |
| Tokens                                              | `packages/auth/src/tokens.ts`                                                           | 32 bytes de sesión, 24 de enlaces mágicos, 16 del token público de pedido; guardados en sha256 y comparados con `timingSafeEqual`                                                                                         |

## Hallazgos

### 🔴 Crítico

**1. Next 16.3.5 vulnerable, en producción.** Aviso crítico, parchado en 16.3.6. La CI de `main`
estaba verde el 24 de septiembre; los avisos se publicaron después, así que nadie se enteró hasta que
un merge se bloqueó. Producción sigue en `ca7749d` con la versión vulnerable.
→ Corregido en el PR #39 (sube a 16.3.8). **Requiere desplegar, no solo mergear.**

### 🟠 Alto

**2. El registro de Supabase Auth está abierto.** `GET /auth/v1/settings` devuelve
`disable_signup: false` y `external.email: true`. La app **no usa Supabase Auth** (identidad propia en
`staff_sessions` / `customer_sessions`), así que es superficie de ataque pura: cualquiera con la clave
pública puede crear filas en `auth.users` y disparar correos de confirmación desde el proyecto.
→ **Acción externa**: no se puede cambiar desde el repositorio. Ver §Acciones externas.
No se probó a crear un usuario de verdad: habría sido escribir en producción.

**3. Credenciales de pago en vivo disponibles en Preview.** `MERCADOPAGO_ACCESS_TOKEN` y
`MERCADOPAGO_WEBHOOK_SECRET` son el **mismo valor** en Production y Preview, así que un despliegue de
preview puede generar cobros reales. Mitigado porque las previews exigen Vercel SSO, pero viola
mínimo privilegio y la regla de no hacer transacciones reales sin autorización.
→ **Acción externa**: en Vercel es una sola variable con dos destinos, y quitarla de Preview por CLI
la borra de **todos** los entornos (ver `feedback_vercel_env_rm_borra_todo`), dejando producción sin
token. No se toca a ciegas en una tienda abierta.

### 🟡 Medio

**4. La comprobación CSRF no decidía sin `Origin`.** `proxy.ts` rechazaba una mutación cuyo `Origin`
no coincidía con el `Host`, pero si la petición no traía `Origin` la dejaba pasar.
→ **Corregido**: se añade `Sec-Fetch-Site: cross-site` como segunda señal (la pone el navegador y no
se puede falsear). La defensa de fondo seguía siendo la cookie `SameSite=Lax`; esto es la capa de
arriba. Con prueba que falla contra el código anterior.

**5. `proxy.ts` no tenía ninguna prueba.** Es lo primero que ve cada petición del CRM y el único sitio
donde vive el CSRF de todas las mutaciones. Un descuido en `PUBLIC_PATHS` abría el panel sin que nada
se quejara. → **Corregido**: `apps/admin/test/proxy.test.ts`, 11 pruebas escritas como intentos de
ataque.

**6. `CRON_SECRET` idéntico en producción y staging.** El secreto de staging abre los endpoints de
cron de producción (alertas de stock, eventos de cliente, avisos push, reintento de webhooks).
→ **Acción externa**: rotar el de staging. No se rota desde aquí porque hay que actualizar los
consumidores a la vez.

**7. Controles de GitHub apagados**, siendo gratis en un repositorio público: secret scanning, push
protection y actualizaciones de seguridad de Dependabot.
→ **Corregido**: los tres encendidos. El escaneo del historial completo devolvió 0 alertas.

**8. Sin `dependabot.yml`.** Las actualizaciones ordinarias no existían; el aviso crítico de Next
apareció solo porque un merge se bloqueó.
→ **Corregido**: semanal, agrupado en parches+menores, con los mayores de framework excluidos a
propósito.

### 🟢 Bajo

**9. `SESSION_SECRET` se exige y no protege nada.** Se valida en `apps/admin/lib/env.ts` y en
`check-env.mjs`, está documentada en `.env.example` bajo "Sesiones / Auth", y **ningún módulo la lee**:
las sesiones son un token aleatorio guardado como sha256. Es idéntica en producción, staging y
preview, lo cual no tiene consecuencia hoy — pero da una falsa sensación de control y alguien podría
creer que rotarla invalida sesiones. → **Corregido en parte**: anotado en el código para que nadie
construya sobre esa suposición. Borrarla del contrato de entorno no gana seguridad.

**10. `APP_ENV=production` también en Preview.** Semánticamente falso. Se revisó qué decide: los
webhooks y la recuperación de contraseña fallan **cerrado** (no escriben tokens en logs), así que el
efecto es conservador, no peligroso. Ensucia el ambiente que reportaría Sentry si algún día se le
diera DSN a preview. → Anotado; corregir junto con el punto 3.

**11. El bucket público `product-images` se puede listar** con la clave pública. Hoy solo tiene fotos
de producto, que son públicas por diseño. Queda anotado para que nadie guarde otra cosa ahí.

**12. Extensiones en el esquema `public`** (`citext`, `pg_trgm`), que el linter de Supabase marca.
Moverlas a su propio esquema obligaría a tocar los tipos de columna de 35 migraciones congeladas.
Riesgo real: ninguno demostrado. No se toca.

## Lo que se decidió NO cambiar, y por qué

**`'unsafe-inline'` en `script-src`.** Es el hueco conocido de la CSP. La alternativa es un nonce por
petición desde el middleware, y eso deja **todas las páginas sin generación estática** — en un sitio
de panadería eso es rendimiento real a cambio de defensa en profundidad. El riesgo que mitigaría ya
está cubierto por lo de abajo: React escapa por defecto, los cinco
`dangerouslySetInnerHTML` del proyecto se revisaron uno por uno (cuatro son constantes del propio
código y el quinto viene de plantillas que escapan todo con `escapeHtml`), y no hay ningún camino
donde texto del usuario llegue sin escapar al HTML. Se asume, se documenta y el smoke test vigila que
`'unsafe-eval'` no aparezca nunca en producción.

**Repositorio público.** No es un hallazgo: la seguridad no depende de ocultar el código, y se
verificó que el historial no tiene secretos. Pero conviene decidirlo a conciencia, porque hacerlo
privado tiene un costo operativo concreto: el monitor corre cada 5 minutos y en un repositorio privado
eso consume minutos de Actions (≈8 600 corridas al mes), mientras que en público son gratis.

**Revisiones obligatorias en `main`.** Exigir una aprobación en un equipo de una persona bloquea todos
los merges: nadie puede aprobar su propio PR. La puerta real ya la pone `deploy.sh` (árbol limpio,
`HEAD == origin/main`, CI en verde) más `required_status_checks` y resolución de conversaciones.

## Cambios implementados

| Archivo                          | Qué                                                                       |
| -------------------------------- | ------------------------------------------------------------------------- |
| `apps/admin/proxy.ts`            | `Sec-Fetch-Site: cross-site` rechaza mutaciones sin `Origin`              |
| `apps/admin/test/proxy.test.ts`  | 11 pruebas nuevas del guardia de entrada                                  |
| `scripts/check-client-bundle.sh` | busca secretos en el JS que baja el navegador (formas + valores reales)   |
| `.github/workflows/ci.yml`       | ejecuta esa revisión después del build                                    |
| `scripts/smoke.sh`               | 12 aserciones de cabeceras de seguridad por app, sobre el despliegue real |
| `.github/dependabot.yml`         | actualizaciones semanales agrupadas                                       |
| `SECURITY.md`                    | política de divulgación y qué es y qué no es vulnerabilidad aquí          |
| `apps/admin/lib/env.ts`          | aviso de que `SESSION_SECRET` no protege nada                             |
| GitHub (ajustes)                 | secret scanning, push protection y Dependabot security updates encendidos |

## El control que mentía

El primer `check-client-bundle.sh` que escribí imprimía `✓ ninguno de los 21 valores de servidor
aparece en el cliente` **con el `SESSION_SECRET` real plantado en un chunk**.

La causa: `grep -rlF -- "$val" "${DIRS[@]}" --include='*.js'`. Con `--include` detrás de las rutas,
grep lo toma por un nombre de archivo que no existe y **sale con código 2 aunque haya encontrado la
coincidencia**. El `if hits=$(grep …) && [ -n "$hits" ]` veía el código 2 y tiraba el hallazgo.

Se arregló moviendo `--include` delante de las rutas y quitándole al código de salida la facultad de
decidir: lo único que decide es si `hits` trae algo. Después se volvió a plantar el secreto y ahora sí
falla.

Esto se deja escrito porque es el modo de fallo más caro de esta clase de trabajo: un control verde
que no mira. Cada comprobación nueva de este informe se probó **plantando lo que debe detectar**.

## Acciones externas requeridas

| Qué                                               | Dónde                                                                                                                       | Qué hacer                                                                                               | Por qué                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Desplegar el parche crítico                       | local                                                                                                                       | mergear #39 y #38, luego `pnpm deploy:prod`                                                             | producción corre Next 16.3.5 vulnerable                                                                         |
| Cerrar el registro de Supabase Auth               | supabase.com → proyecto `pan-de-paula` → Authentication → Sign In / Providers → Email → **Allow new users to sign up: off** | elimina escrituras anónimas a `auth.users` y envío de correos                                           | la app no usa Supabase Auth: es superficie gratis para un atacante                                              |
| Credenciales de prueba de Mercado Pago en Preview | developers.mercadopago.com.mx (credenciales de prueba) → Vercel → Settings → Environment Variables, en **ambos** proyectos  | crear la variable solo para Preview con el token de prueba, y dejar la de producción solo en Production | un preview no debe poder cobrar de verdad. Cuidado: por CLI, borrar la variable de un entorno la borra de todos |
| `APP_ENV=staging` en Preview                      | Vercel, ambos proyectos                                                                                                     | separar la variable por entorno                                                                         | hoy un preview se identifica como producción                                                                    |
| Rotar `CRON_SECRET` de staging                    | Vercel (Preview) + `.env.staging`                                                                                           | generar uno distinto al de producción                                                                   | el de staging abre los crons de producción                                                                      |
| PITR en Supabase                                  | supabase.com → Database → Backups                                                                                           | contratar el add-on                                                                                     | entre dos respaldos diarios se pueden perder 24 h de ventas                                                     |
| Secretos del respaldo diario                      | `gh secret set` (ver `docs/BACKUP_RESTORE.md` §capa 4)                                                                      | cargar los cuatro                                                                                       | el workflow `Respaldo` falla sin ellos                                                                          |
| Decidir si el repositorio sigue público           | GitHub → Settings                                                                                                           | decisión, no corrección                                                                                 | ver §Lo que se decidió NO cambiar                                                                               |

## Riesgos residuales

1. `'unsafe-inline'` en `script-src` (asumido, con el razonamiento arriba).
2. Credenciales de pago en vivo alcanzables desde Preview hasta que se separen (mitigado por SSO).
3. `CRON_SECRET` compartido con staging.
4. Sin PITR: ventana de pérdida de hasta 24 h.
5. El respaldo diario vive en el mismo proveedor que la base: protege de un borrado, no de perder la
   cuenta.
6. `enforce_admins: false` en la protección de `main`: el dueño puede saltarse la puerta. Es la salida
   de emergencia de un equipo de una persona; queda como decisión consciente.
7. Actions apaga los workflows programados tras 60 días sin actividad en el repositorio. El monitor y
   el respaldo se detendrían juntos; GitHub avisa por correo antes.
