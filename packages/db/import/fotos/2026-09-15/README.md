# Fotos de producto · 2026-09-15

Fuente: carpeta de Google Drive compartida por el dueño el 2026-09-15 (20 fotos, una por producto, nombradas
`<n>_<Producto>.jpg`). `fotos.csv` relaciona cada archivo con su producto y guarda el nombre original.

Preparación: orientación según EXIF, ancho máximo 1200 px y WebP calidad 80. Al convertir se eliminan los
metadatos (incluida la ubicación GPS del teléfono). Ninguna foto se retocó ni se generó.

## Aplicar

```bash
bash scripts/fotos-productos.sh staging              # simulación
bash scripts/fotos-productos.sh production --apply   # respaldo + sube a Supabase Storage + imagen principal
```

Usa la misma subida que el admin (`uploadImage`). Idempotente: un producto que ya tiene imagen no se toca, así
que una foto subida después desde el admin nunca se pisa. Prueba en `apps/web/test/product-photos.test.ts`.

## Notas

- Resolución baja en origen (514×913): Croissant Natural, Croissant Chocolate Almendra, Croissant Pumpkin Spice y
  Pan de Muerto. Se ven bien en tarjetas; con originales más grandes lucirían mejor en el Home y en su ficha.
- Sin foto todavía: Croissant S'mores y Croissant Dubai (usan la foto editorial del Home), Croissant Pistache,
  Croissant Magnum, Galleta Kinder Bueno, Docena Mini Croissant… ver el menú para la lista viva.
