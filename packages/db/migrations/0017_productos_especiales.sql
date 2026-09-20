-- 0017_productos_especiales.sql — Productos especiales o temporales (navideños, de temporada, ediciones limitadas).
--
-- Aditiva y de un solo campo: NO existe un modelo nuevo. Un producto especial es una fila normal de
-- `products` y se vende, se produce, se inventaría, se reporta y se publica exactamente igual que
-- cualquier otro. La columna solo lo MARCA para poder listarlo y editarlo rápido desde Producción.
--
-- Convención (ver docs/ADMIN_MANUAL.md → "Productos especiales" y docs/PRODUCTION_MANUAL.md):
--   · `is_temporary = true`  → aparece en /produccion?tab=especiales (alta y edición rápida).
--   · Precio           → `product_prices` vía `set_regular_price` (historial; nunca se reescribe).
--   · Stock inicial    → `record_stock_correction(..., 'initial', …)` (movimiento INITIAL, append-only).
--   · Retirar          → `is_active = false`. NO se borra: conserva ventas, pedidos, movimientos y precios,
--                        y la temporada siguiente se reactiva la misma fila.
--   · `tags` NO se usa para esto: las etiquetas ya significan insignias del sitio ("nuevo").
alter table products add column if not exists is_temporary boolean not null default false;

comment on column products.is_temporary is
  'Producto especial o temporal (navideño, de temporada, edición limitada). Solo lo marca para la sección "Especiales" de Producción: no cambia ninguna regla de venta, catálogo, inventario ni reportes. Retirarlo = is_active = false (nunca borrar).';

-- Índice parcial: los especiales son una fracción del catálogo y la lista se ordena por nombre.
create index if not exists products_temporary_idx
  on products (name)
  where is_temporary and deleted_at is null;
