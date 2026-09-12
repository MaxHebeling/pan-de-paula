## Qué cambia

## Por qué

## Definition of Done
- [ ] Tests añadidos/actualizados (unit / integración DB / E2E según aplique) y en verde
- [ ] Sin lógica de venta/stock/puntos reimplementada en TypeScript (solo funciones SQL)
- [ ] Migraciones aditivas en el rango del módulo; `pnpm db:codegen` ejecutado
- [ ] Validación zod en servidor; mutaciones dentro de `withStaff`; permiso verificado
- [ ] Sin secretos ni `catch` vacíos; variables nuevas en `.env.example` y `turbo.json`
- [ ] Documentación actualizada si cambia comportamiento, operación o configuración
- [ ] Plan de rollback claro para cambios críticos
