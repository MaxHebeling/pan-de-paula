# Migraciones

- Archivos `NNNN_nombre.sql`, aplicados en orden por `pnpm db:migrate` (una transacción por archivo, checksum registrado en `schema_migrations`).
- **Inmutables una vez publicadas** (listadas en `RELEASED`). Para cambiar algo publicado: nueva migración.
- Aditivas y compatibles hacia atrás (la app anterior debe seguir funcionando durante un rollback de aplicación).
- Rangos reservados por módulo para trabajo en paralelo (se permiten huecos):
  - `0001–0009` núcleo · `0010–0019` catálogo/recetas/configuración · `0020–0029` POS/caja · `0030–0039` producción/inventario/pedidos
  - `0040–0049` clientes/fidelización/reportes · `0050–0059` sitio público · `0060–0069` integraciones · `0070–0079` importación/observabilidad
- Tras migrar: `pnpm db:codegen` regenera `packages/db/src/generated/db.ts`.
