-- Ficha del negocio en Google Maps (enlace del dueño, 2026-09-24).
--
-- El enlace corto que compartió resuelve a:
--   El Pan de Paula, París 410, Playas de Tijuana, Costa Azul, 22506 Tijuana, B.C.
--   identificador del lugar 0x80d94b003afd724b:0xa1a08a3cdb7b5d92
--
-- `map_embed_url` ancla el mapa a ESE lugar por su CID (11646460630365068690, el segundo número del
-- identificador en decimal), no a una búsqueda por dirección: así el pin sale rotulado con el nombre
-- del negocio y su ficha, en vez de un punto genérico sobre la calle.
--
-- `maps_url` es el destino del enlace "Abrir en Google Maps": el corto abre la app con la ficha.
--
-- Ambos son anulaciones opcionales; si se borran, el sitio vuelve a derivar el mapa de `address`.
\set ON_ERROR_STOP on
begin;

update business_settings
   set policies = coalesce(policies, '{}'::jsonb)
     || jsonb_build_object(
          'map_embed_url', 'https://www.google.com/maps?cid=11646460630365068690&z=16&output=embed',
          'maps_url', 'https://maps.app.goo.gl/9vutL1xHgkJtbTur6'
        )
 where id = 1;

commit;
