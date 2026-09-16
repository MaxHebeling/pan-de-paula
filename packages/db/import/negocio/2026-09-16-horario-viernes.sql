-- Horario real de El Pan de Paula (indicado por el dueño el 2026-09-16):
--   Atención y entrega: VIERNES de 6:00 p.m. a 10:00 p.m. El resto de los días, cerrado.
--   Pedidos: se pueden hacer cualquier día; cierran el MIÉRCOLES a las 6:00 p.m. para el viernes siguiente.
--
-- Son datos de negocio (editables desde el CRM → Configuración), no esquema: este archivo solo deja el
-- cambio escrito y reproducible. Idempotente: correrlo dos veces deja exactamente el mismo estado.
--
-- Por qué `order_weekdays = {0,1,2,3}` (domingo a miércoles) y no los siete días: el sistema calcula el
-- cierre como el ÚLTIMO día de pedido anterior a la entrega (packages/domain/src/calendar.ts →
-- lastOrderMoment). Con domingo-miércoles el cierre cae el miércoles a las 18:00, que es lo pedido.
-- Quien entra un jueves, viernes o sábado sigue pudiendo pedir: la tienda le ofrece el viernes siguiente.

\set ON_ERROR_STOP on
begin;

-- 1) Horario de atención: solo viernes 18:00–22:00.
update business_hours
   set is_open = (weekday = 5),
       opens_at = case when weekday = 5 then time '18:00' end,
       closes_at = case when weekday = 5 then time '22:00' end;

-- 2) Ventana de pedidos: entrega el viernes en el mismo horario de atención.
update ordering_windows
   set name = 'Viernes',
       fulfillment_type = 'scheduled_pickup',
       order_weekdays = '{0,1,2,3}',
       cutoff_time = time '18:00',
       fulfillment_weekday = 5,
       fulfillment_from = time '18:00',
       fulfillment_to = time '22:00',
       lead_days_min = 1,
       is_active = true
 where is_active;

-- Si no existía ninguna ventana activa, se crea la del viernes (primera instalación).
insert into ordering_windows (name, fulfillment_type, order_weekdays, cutoff_time, fulfillment_weekday,
                              fulfillment_from, fulfillment_to, lead_days_min, is_active, sort_order)
select 'Viernes', 'scheduled_pickup', '{0,1,2,3}', time '18:00', 5, time '18:00', time '22:00', 1, true, 1
 where not exists (select 1 from ordering_windows where is_active);

commit;
