-- Dirección real de la panadería (dato del dueño, 2026-09-21).
--
-- Toca dos cosas que hasta hoy estaban en blanco o con el texto de ejemplo:
--   · `business_settings`: lo que se ve en el sitio, en los comprobantes y en los correos;
--   · el punto de retiro por defecto: lo que lee el cliente al elegir "recoger en la panadería".
--
-- Idempotente: repetirlo deja exactamente el mismo estado. No toca teléfono, WhatsApp ni correo,
-- que siguen pendientes de que el dueño los confirme (no se inventan).
\set ON_ERROR_STOP on
begin;

update business_settings set
  address = 'Avenida París #410, Sección Costa Azul, Playas de Tijuana, C.P. 22506',
  city    = 'Tijuana',
  state   = 'Baja California',
  country = 'MX'
where id = 1;

-- El punto de retiro por defecto es la panadería: mismo domicilio, dicho como lo leería un cliente.
update pickup_points set
  name    = 'Panadería (mostrador)',
  address = 'Avenida París #410, Sección Costa Azul, Playas de Tijuana, C.P. 22506',
  city    = 'Tijuana',
  is_active = true
where is_default;

commit;
