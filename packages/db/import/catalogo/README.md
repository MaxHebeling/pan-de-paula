# Catálogo real · 2026-09-15

Fuente: hoja de Google Sheets entregada por el dueño el 2026-09-15 (copia exacta en
`2026-09-15-hoja-original.xlsx`). Reemplaza en la tienda a los 16 productos de demostración del seed.

| Archivo                           | Qué es                                                                   |
| --------------------------------- | ------------------------------------------------------------------------ |
| `2026-09-15-hoja-original.xlsx`   | La hoja tal cual se recibió (nombre, descripción, precio).               |
| `2026-09-15-catalogo-real.csv`    | La misma hoja con categoría, unidad, activo, destacado y orden.          |
| `2026-09-15-precios.csv`          | Precio de la hoja para productos que ya existían (Croissant Dubai).      |
| `2026-09-15-1-preparar.sql`       | Retira los productos demo (inactivos, sin borrar) y crea las categorías. |
| `../mappings/catalogo-real*.json` | Mapeos del importador.                                                   |

## Aplicar

```bash
bash scripts/catalogo-real.sh staging              # simulación
bash scripts/catalogo-real.sh staging --apply      # respaldo + aplica
bash scripts/catalogo-real.sh production --apply   # respaldo + aplica (exige .env.production)
```

Opcional: `IMPORT_STAFF_EMAIL=<correo>` para que el lote quede a nombre de esa persona en auditoría.
Es idempotente: repetirlo no duplica productos ni desactiva los reales (prueba en `packages/db/test/catalogo_real.test.ts`).

## Decisiones tomadas al preparar la hoja (revisables en el admin)

- **Categorías**: Croissants, Kouign-amann, Galletas, Para compartir (docenas y la trenza), Temporada y Tradicionales.
- **Sin precio en la hoja → inactivos**: Croissant de Reyes, Kouign-amann Guayaba, Rosca de Reyes, Galleta M&M's,
  Docena Mini Galletas, Coricos, Puerquitos y Polvorones. Para venderlos: asignar precio y activarlos.
- **Erratas corregidas en el nombre**: «Kougn-amann Churro» y «Kouig-amann Guayaba» → «Kouign-amann …».
- **Destacados del Home**: los cuatro croissants con fotografía real (Chocolate Almendra, S'mores, Dubai, Pistache).
- **Temporada**: los productos de temporada con precio quedan activos y sin fechas; el dueño decide cuándo apagarlos.
- **Croissant Dubai**: descripción y precio de la hoja ($115); se quita la etiqueta «nuevo» del seed.
- Las recetas e ingredientes del seed demo no se tocan (hoja de costos): revisar en el admin.
