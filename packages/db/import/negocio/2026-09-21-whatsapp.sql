-- WhatsApp del negocio (dato del dueño, 2026-09-21): +52 664 311 7892.
--
-- Es el número por el que el sitio abre la conversación (botón de WhatsApp del pie de página, la
-- página de ubicación y los avisos del portal). NO se toca `phone`: el dueño dio el WhatsApp, y el
-- teléfono para llamadas se confirma aparte en vez de suponer que es el mismo.
\set ON_ERROR_STOP on
begin;

update business_settings set whatsapp = '+52 664 311 7892' where id = 1;

commit;
