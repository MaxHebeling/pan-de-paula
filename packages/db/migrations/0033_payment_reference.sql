-- 0033_payment_reference.sql — Referencia CONTABLE del pago (conciliación bancaria).
--
-- La columna ya existe desde 0005 (`payments.reference`, text opcional). Esta migración NO crea columnas
-- ni toca datos: los pagos históricos sin referencia se quedan sin ella. Solo agrega:
--   1) el índice que hace barata la búsqueda por referencia desde el buscador del CRM y los filtros, y
--   2) `set_payment_reference`, la única vía para corregir la referencia de un pago YA registrado.
--
-- Qué es qué (no se mezclan nunca):
--   · reference        → lo que escribe el negocio para conciliar: clave de rastreo SPEI, folio de
--                        autorización de la terminal, id del depósito ("BANORTE-483920", "TRX-8493021").
--   · external_id      → id del pago en el proveedor (Mercado Pago). Lo escribe la integración.
--   · external_status  → estado del proveedor. · idempotency_key → clave anti-duplicado. · metadata → payload crudo.
-- `set_payment_reference` solo escribe `reference`; los identificadores del proveedor quedan intactos.
--
-- En pagos divididos cada fila de `payments` es una parte y lleva SU PROPIA referencia
-- (pos_checkout ya registra una fila por parte, con idempotencia por posición — ver 0013).

create extension if not exists pg_trgm;

-- Búsqueda por referencia con `ilike '%texto%'` (buscador global, /pos/ventas, /pedidos, reporte de pagos).
create index if not exists payments_reference_trgm_idx on payments using gin (reference gin_trgm_ops);

/**
 * Captura o corrige la referencia contable de un pago ya registrado.
 * Pasar null / cadena vacía la borra (un pago puede quedarse sin referencia; es opcional).
 * El trigger `trg_audit_payments` (0005) registra el cambio en audit_logs con current_staff_id().
 */
create or replace function set_payment_reference(p_payment_id uuid, p_reference text)
returns jsonb
language plpgsql as $$
declare
  pm payments%rowtype;
  v_new text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  select * into pm from payments where id = p_payment_id for update;
  if pm.id is null then raise exception 'El pago no existe'; end if;
  if v_new is not null and length(v_new) > 80 then
    raise exception 'La referencia no puede pasar de 80 caracteres' using errcode = 'check_violation';
  end if;
  if v_new ~ '[[:cntrl:]<>]' then
    raise exception 'La referencia solo admite letras, números y signos simples' using errcode = 'check_violation';
  end if;
  if v_new is not distinct from pm.reference then
    return jsonb_build_object('payment_id', pm.id, 'order_id', pm.order_id,
                              'old_reference', pm.reference, 'reference', v_new, 'changed', false);
  end if;
  update payments set reference = v_new where id = pm.id;
  return jsonb_build_object('payment_id', pm.id, 'order_id', pm.order_id,
                            'old_reference', pm.reference, 'reference', v_new, 'changed', true);
end $$;
