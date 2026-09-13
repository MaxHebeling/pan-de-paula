# Respaldo y restauración

Un respaldo que no se ha restaurado no existe. Este documento define qué se respalda, cada cuánto, cómo se
prueba y qué tiempos de recuperación esperamos.

## Objetivos

| Métrica | Objetivo                                                        | Cómo se cumple                                                                                                                                     |
| ------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO** | ≤ 24 h con respaldos lógicos · **≤ 2 min con PITR** de Supabase | PITR (plan Pro, WAL continuo) + `pg_dump` diario y antes de cada deploy                                                                            |
| **RTO** | ≤ 60 min para volver a operar (POS)                             | Restauración a un proyecto/base nueva + cambiar `DATABASE_URL` + redeploy. El simulacro mensual mide el tiempo real (`backups/restore-drills.log`) |

## Capas

1. **Supabase — Daily backups** (incluidos): retención 7 días (Pro). Restauración desde el dashboard
   (Database → Backups) sobre el mismo proyecto: reemplaza todo el estado.
2. **Supabase — PITR** (add-on del plan Pro): permite volver a cualquier minuto dentro de la ventana contratada
   (7–28 días). Es la herramienta para "se borró/alteró algo a las 10:32". Actívalo antes del go-live.
3. **Respaldo lógico propio — `scripts/backup.sh`**: `pg_dump --format=custom` comprimido, verificado con
   `pg_restore --list`, portable a cualquier Postgres 17 (independiente del proveedor). Incluye **solo el esquema
   `public` más las extensiones** de las que dependen las tablas (`--extension=citext/pgcrypto/pg_trgm`, lista viva
   desde `pg_extension`); sin ellas un dump `--schema=public` no se puede restaurar en una base nueva (cada tabla con
   `citext` falla). El script se niega a dar por bueno un dump sin extensiones.
   - `pnpm backup` → `bash scripts/backup.sh local` usando `.env`.
   - `bash scripts/backup.sh production [etiqueta]` usa `.env.production` (solo en la máquina del operador).
   - Salida: `backups/pdp-<env>-<AAAAMMDD-HHMMSS>-<etiqueta>.dump` + línea en `backups/backups-<env>.log`.
   - `deploy.sh` lo ejecuta automáticamente antes de migrar producción (`pre-deploy-<sha>`).
   - Retención local: conserva los **14 más recientes por ambiente** y borra el resto.
   - Los `.dump` están en `.gitignore`: **súbelos a un almacenamiento externo cifrado** (por ejemplo un bucket
     privado de Supabase Storage/S3 o disco cifrado fuera de la oficina). Contienen datos personales de clientes.

Calendario mínimo: diario automático (Supabase) + `backup.sh production diario` programado en la máquina del
operador (launchd/cron) + `pre-deploy` en cada publicación.

## Simulacro de restauración — `scripts/restore-drill.sh`

```bash
pnpm restore:drill                      # usa el .dump más reciente en backups/
bash scripts/restore-drill.sh backups/pdp-production-20260901-020000-diario.dump
```

Qué hace: crea una base local temporal `pdp_restore_drill_<ts>`, crea las extensiones (`pgcrypto`, `citext`,
`pg_trgm`; compatible con dumps anteriores que no las traían), `pg_restore` completo, **falla si `pg_restore`
reporta cualquier error real o si el número de tablas restauradas no coincide con las del dump**, imprime conteos de
`products`, `orders`, `customers`, `schema_migrations` (avisa si el dump tiene menos migraciones que el repo),
ejecuta una función de negocio en lectura (`suggested_production(current_date)`) para comprobar que las funciones
restauraron, borra la base (también si falla: `trap`) y registra duración y resultado (`OK`/`FAIL`) en
`backups/restore-drills.log`. **Ese tiempo es tu RTO medido** (local, con seed + demo: 1 s; el RTO real de producción
lo dominan crear el proyecto, cambiar `DATABASE_URL` y redeployar).

Hazlo **una vez al mes** (primer lunes) y después de cambios grandes de esquema. Requisitos: Postgres 17 local
(`createdb`, `pg_restore`, `psql` en PATH).

## Restauración real en producción

### A. Volver atrás en el tiempo (dato borrado/alterado) — PITR

1. Congela la operación (avisa a caja; el POS deja de vender unos minutos).
2. Supabase → Database → Point in Time → elige el minuto anterior al incidente. Supabase restaura el mismo
   proyecto (la `DATABASE_URL` no cambia).
3. Verifica: `curl /api/ready`, entra al CRM, revisa el último pedido/venta. Recaptura lo que se perdió entre el
   punto de restauración y ahora (usa el reporte de caja/tickets impresos).
4. Postmortem.

### B. Proyecto perdido o migración a otro Postgres — respaldo lógico

1. Crea la base destino (nuevo proyecto Supabase o Postgres propio).
2. Crea las extensiones antes de restaurar (los dumps nuevos ya las incluyen; hacerlo es idempotente):
   ```sql
   create extension if not exists pgcrypto; create extension if not exists citext; create extension if not exists pg_trgm;
   ```
   Restaura como owner:
   ```bash
   pg_restore --no-owner --no-privileges --dbname "$NUEVA_DATABASE_URL_DIRECTA" backups/pdp-production-<stamp>.dump
   ```
   `--no-privileges` omite los grants: vuelve a correr la parte de seguridad para el rol de la app:
   ```sql
   -- si el rol no existe en el destino
   create role pdp_app login password '<contraseña>';
   grant usage on schema public to pdp_app;
   grant select, insert, update, delete on all tables in schema public to pdp_app;
   grant usage, select on all sequences in schema public to pdp_app;
   grant execute on all functions in schema public to pdp_app;
   ```
   (RLS y políticas viajan con el dump porque forman parte de las tablas.) Y vuelve a cerrar el EXECUTE de funciones
   a `PUBLIC` (los grants no viajan con `--no-privileges`):
   ```sql
   revoke execute on all routines in schema public from public, anon, authenticated;
   alter default privileges revoke execute on routines from public;
   ```
   Comprueba con `psql -f scripts/db-integrity.sql` (bloque 9: `funciones_publicas = 0`).
3. `pnpm db:migrate` con la URL nueva: no debe quedar nada pendiente (el dump incluye `schema_migrations`).
   El único error tolerable de `pg_restore` es `schema "public" already exists`; cualquier otro = restauración incompleta.
4. `select rebuild_inventory_levels();` no es necesario (los niveles viajan), pero es barato y elimina dudas.
5. Cambia `DATABASE_URL` en ambos proyectos Vercel → redeploy (`vercel --prod` desde cada app o `pnpm deploy:prod`).
6. Smoke + prueba manual de una venta en POS.

## Qué NO cubre un respaldo de base

- Imágenes de productos en Storage/`public/uploads`: respalda el bucket aparte (o acepta re-subirlas).
- Variables de entorno: guarda una copia cifrada de `.env.production` fuera del repo.
- Tokens de Mercado Pago/Meta: se regeneran desde sus paneles.

## Checklist mensual

- [ ] `pnpm restore:drill` ejecutado y anotado en `backups/restore-drills.log` (RTO < 60 min).
- [ ] Último `backup.sh production` de menos de 24 h y copiado fuera de la máquina.
- [ ] PITR activo y ventana vigente en el dashboard de Supabase.
- [ ] Espacio en disco de `backups/` y del almacenamiento externo.
