# Seguridad

Este repositorio es **público** y el sistema que contiene opera una panadería real: cobra en línea,
guarda datos de clientes y sirve el sitio y el CRM de El Pan de Paula.

## Reportar una vulnerabilidad

Escribe a **maxhebeling@gmail.com** con el asunto `SEGURIDAD · pan-de-paula`. Si puedes, incluye:

- qué falla y qué permite hacer;
- cómo reproducirlo (una petición, un paso, una captura);
- el commit o la URL donde lo viste.

Respondemos en cuanto lo vemos. Al ser un proyecto de una sola persona no hay guardia 24/7 ni programa
de recompensas.

**Por favor no abras un issue público** para algo explotable: el repositorio lo lee cualquiera.

### Qué pedimos

- No uses datos de clientes reales ni los descargues. Si tropiezas con información personal, para y
  cuéntanoslo.
- No hagas pruebas de carga ni de denegación de servicio contra `www.pandepaula.com` ni
  `crm.pandepaula.com`: es una tienda abierta, no un laboratorio.
- No intentes cobros reales. El cobro en línea está en vivo.
- Danos un tiempo razonable para arreglarlo antes de publicarlo.

## Qué es y qué no es una vulnerabilidad aquí

El código es público **a propósito**. Que se pueda leer el esquema, las políticas de acceso o la
lógica de negocio no es una falla: la seguridad del sistema no depende de que nadie vea el código.

Esto **sí** nos interesa:

- leer o escribir datos de un cliente siendo otro, o sin sesión;
- subir de permisos (de usuario normal a administrador);
- cualquier escritura en la base sin autenticación;
- un cobro, reembolso o pago marcado como válido sin que el proveedor lo confirme;
- un secreto accesible desde el navegador;
- ejecución de código, inyección (SQL u otra), SSRF, o lectura de archivos del servidor;
- saltarse el límite de intentos del login o del portal de clientes.

Esto **no** lo tratamos como vulnerabilidad:

- que el HTML, el CSS o el JavaScript del sitio se puedan copiar;
- `'unsafe-inline'` en `script-src`: está documentado y asumido en
  [docs/RELIABILITY.md](docs/RELIABILITY.md), porque Next inyecta sus propios scripts de hidratación
  sin nonce y la alternativa deja todas las páginas sin generación estática;
- las funciones de las extensiones de Postgres (`citext`, `pg_trgm`, `pgcrypto`) ejecutables por el rol
  `anon`: las concede Supabase, pertenecen a `supabase_admin` y el rol migrador no puede revocarlas.
  Ninguna función de negocio ni tabla es accesible — lo verifica `scripts/check-grants.sh` en cada
  despliegue y la prueba `packages/db/test/security_grants.test.ts`;
- informes automáticos de un escáner sin un caso reproducible.

## Cómo está defendido

El detalle vive en [docs/RELIABILITY.md](docs/RELIABILITY.md) y en los informes de
[docs/audit/](docs/audit/). En resumen: el navegador solo habla con el servidor; el servidor decide
precios, permisos y cobros; la base tiene RLS en todas las tablas y no es accesible con la clave
pública de Supabase; cada despliegue verifica grants, cabeceras y secretos antes de publicar.
