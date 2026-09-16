-- 0016_instagram_handle.sql — Handle oficial de Instagram: @el.pandepaula.
--
-- `business_settings.instagram_handle` es la fuente de verdad (el sitio y el CRM leen de ahí).
-- El seed original dejó 'elpandepaula', que no existe como cuenta: la cuenta real es 'el.pandepaula'.
-- Producción ya tiene el valor viejo grabado, así que la corrección viaja como migración de datos.
--
-- Idempotente y conservadora: solo toca la fila si está vacía o si conserva el valor del seed viejo.
-- Si alguien configuró otro handle a mano desde el CRM, NO se pisa.
update business_settings
   set instagram_handle = 'el.pandepaula'
 where id = 1
   and coalesce(instagram_handle, '') in ('', 'elpandepaula', '@elpandepaula');
