-- Catálogo real de El Pan de Paula (hoja entregada por el dueño el 2026-09-15).
-- Paso 1 de 3 · Retira los productos de DEMOSTRACIÓN del seed y prepara las categorías reales.
-- Idempotente y sin borrados: los productos demo quedan inactivos (siguen en el admin, con su historial)
-- y su slug pasa a terminar en "-demo" para liberar el slug a los productos reales (p. ej. galleta-chispas).
-- Croissant Dubai NO es demo: existe en la hoja real; aquí solo se alinea con ella.

\set ON_ERROR_STOP on

-- 1) Productos demo del seed (packages/db/scripts/seed.ts), excepto croissant-dubai.
update products p
   set is_active = false,
       show_on_web = false,
       show_on_pos = false,
       is_featured = false,
       pos_favorite = false,
       slug = p.slug || '-demo'
  from (values ('croissant-mantequilla', 'Croissant de mantequilla'),
               ('croissant-chocolate', 'Croissant de chocolate'),
               ('croissant-almendra', 'Croissant de almendra'),
               ('galleta-chispas', 'Galleta de chispas de chocolate'),
               ('galleta-nuez', 'Galleta de nuez'),
               ('rol-canela', 'Rol de canela'),
               ('rol-nutella', 'Rol de Nutella'),
               ('concha-vainilla', 'Concha de vainilla'),
               ('concha-chocolate', 'Concha de chocolate'),
               ('brownie-clasico', 'Brownie clásico'),
               ('brownie-nuez', 'Brownie con nuez'),
               ('polvoron', 'Polvorón'),
               ('cochinito', 'Cochinito de piloncillo'),
               ('caja-6-croissants', 'Caja de 6 croissants'),
               ('rosca-temporada', 'Rosca de temporada')) as demo(slug, name)
 -- slug Y nombre del seed: una segunda corrida no toca a los productos reales que heredan el slug.
 where p.slug = demo.slug
   and p.name = demo.name
   and p.deleted_at is null;

-- 2) Categorías reales, en el orden en que se muestran (reutiliza las existentes por slug).
insert into categories (slug, name, sort_order)
values ('croissants', 'Croissants', 1),
       ('kouign-amann', 'Kouign-amann', 2),
       ('galletas', 'Galletas', 3),
       ('para-compartir', 'Para compartir', 4),
       ('temporada', 'Temporada', 5),
       ('tradicionales', 'Tradicionales', 6)
on conflict (slug) do update
   set name = excluded.name, sort_order = excluded.sort_order, is_active = true, deleted_at = null;

-- Las categorías demo que quedan sin productos se ocultan solas en la web; se mandan al final del orden.
update categories
   set sort_order = 100
 where slug in ('roles', 'pan-dulce', 'brownies', 'polvorones', 'cochinitos', 'combos', 'dubai')
   and sort_order < 100;

-- 3) Croissant Dubai con los datos de la hoja (el precio se actualiza en el paso 3, con historial).
update products
   set category_id = (select id from categories where slug = 'croissants'),
       short_description = 'Croissant de mantequilla relleno de crema de pistache y kataifi crujiente, cubierto con chocolate oscuro y terminado con trozos de pistache y kataifi.',
       is_featured = true,
       -- La etiqueta «nuevo» venía del seed demo, no de la hoja.
       tags = array_remove(tags, 'nuevo'),
       sort_order = 50
 where slug = 'croissant-dubai'
   and deleted_at is null;
