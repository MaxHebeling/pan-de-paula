# Fotos de producto · 2026-09-23 (nueva temporada)

La carpeta de Drive del dueño trae 21 fotos con la convención `<n>_<Producto>.jpg`. Veinte ya se
aplicaron en el lote [2026-09-15](../2026-09-15/) y siguen siendo los mismos archivos: se comparó una
por una contra `fotos.csv` de aquel lote y no cambió ninguna. **La única foto nueva es la 21**, la del
producto que esta temporada se da de alta.

Preparación idéntica a la del lote anterior: orientación según EXIF, ancho máximo 1200 px, WebP
calidad 80. Al convertir se eliminan los metadatos, incluida la ubicación GPS del teléfono. La foto no
se retocó ni se generó.

## Aplicar

```bash
bash scripts/fotos-productos.sh production --dry-run  packages/db/import/fotos/2026-09-23
bash scripts/fotos-productos.sh production --apply    packages/db/import/fotos/2026-09-23
```

Idempotente: un producto que ya tiene imagen no se toca, así que repetirlo no pisa nada.
