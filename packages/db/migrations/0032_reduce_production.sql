-- 0032_reduce_production.sql — Restar producción del día desde el tablero de Producción.
-- Aditiva: solo agrega `reduce_production`. No cambia `record_production` ni `undo_production`.
--
-- Es la operación inversa de `record_production` expresada en CANTIDAD (no en lote):
--   · Toma los lotes de HOY (fecha local del negocio, `business_settings.timezone`) del producto,
--     `undone_at is null`, bloqueados `for update`, del más nuevo al más viejo.
--   · Nunca deja producción negativa: si la cantidad supera lo producido hoy, falla con check_violation.
--   · Cada lote consumido genera un `inventory_movements` CORRECTION negativo con
--     `ref_type = 'production_batch'` y `ref_id` del lote, igual que `undo_production`
--     (el inventario sigue siendo append-only: nada se borra).
--   · Si el lote cabe completo se marca `undone_at`; si sobra, se reduce su `qty` (resta parcial).
--   · Devuelve los insumos en la proporción correspondiente, tomando el consumo NETO que aún queda
--     asociado al lote (consumo + devoluciones previas), para que varias restas parciales sumen exactamente
--     lo que se consumió y ni un gramo más.

create or replace function reduce_production(p_product_id uuid, p_qty numeric, p_note text default null)
returns jsonb language plpgsql as $$
declare
  v_tz        text;
  v_today     date;
  v_available numeric;
  v_left      numeric;
  v_take      numeric;
  v_return    numeric;
  v_on_hand   numeric;
  v_affected  integer := 0;
  v_batches   jsonb := '[]'::jsonb;
  v_note      text;
  b           production_batches%rowtype;
  it          record;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'Cantidad inválida' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no existe';
  end if;
  v_note := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'restar producción');

  select timezone into v_tz from business_settings where id = 1;
  v_today := (now() at time zone v_tz)::date;

  -- Bloquea los lotes de hoy ANTES de medir: dos cajeros no pueden restar lo mismo dos veces.
  perform 1 from production_batches
   where product_id = p_product_id and undone_at is null
     and (produced_at at time zone v_tz)::date = v_today
   for update;

  select coalesce(sum(qty), 0) into v_available from production_batches
   where product_id = p_product_id and undone_at is null
     and (produced_at at time zone v_tz)::date = v_today;

  if p_qty > v_available then
    raise exception 'No puedes restar % : hoy solo se han producido % de este producto',
      trim_scale(p_qty), trim_scale(v_available) using errcode = 'check_violation';
  end if;

  v_left := p_qty;
  for b in
    select * from production_batches
     where product_id = p_product_id and undone_at is null
       and (produced_at at time zone v_tz)::date = v_today
     order by produced_at desc, created_at desc, id desc
  loop
    exit when v_left <= 0;
    v_take := least(b.qty, v_left);

    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, note, staff_id)
    values (b.product_id, 'CORRECTION', -v_take, 'production_batch', b.id::text, 'reduce', v_note, current_staff_id());

    -- Devolución proporcional de insumos sobre el consumo neto que aún queda del lote.
    if b.ingredients_consumed then
      for it in
        select ingredient_id, sum(qty) as net
          from ingredient_movements
         where ref_type = 'production_batch' and ref_id = b.id::text
         group by ingredient_id
        having sum(qty) < 0
      loop
        v_return := round((-it.net) * v_take / b.qty, 3);
        if v_return <> 0 then
          insert into ingredient_movements(ingredient_id, type, qty, ref_type, ref_id, note, staff_id)
          values (it.ingredient_id, 'CORRECTION', v_return, 'production_batch', b.id::text,
                  'restar producción lote ' || b.lot_code, current_staff_id());
        end if;
      end loop;
    end if;

    if v_take >= b.qty then
      update production_batches set undone_at = now() where id = b.id;
    else
      update production_batches set qty = b.qty - v_take where id = b.id;
    end if;

    v_batches := v_batches || jsonb_build_object(
      'batch_id', b.id, 'lot_code', b.lot_code, 'qty', v_take, 'fully_undone', v_take >= b.qty);
    v_affected := v_affected + 1;
    v_left := v_left - v_take;
  end loop;

  select coalesce(sum(qty), 0) into v_available from production_batches
   where product_id = p_product_id and undone_at is null
     and (produced_at at time zone v_tz)::date = v_today;
  select coalesce(on_hand, 0) into v_on_hand from inventory_levels where product_id = p_product_id;

  perform emit_event('PRODUCTION_REDUCED', 'product', p_product_id::text,
                     jsonb_build_object('qty', p_qty, 'batches', v_batches, 'batches_affected', v_affected,
                                        'produced_today', v_available));

  return jsonb_build_object(
    'produced_today', v_available,
    'on_hand', coalesce(v_on_hand, 0),
    'batches_affected', v_affected);
end $$;

-- Las funciones nuevas heredan EXECUTE a PUBLIC: se cierra explícitamente (ver 0009 y 0050).
revoke execute on function reduce_production(uuid, numeric, text) from public, anon, authenticated;
grant execute on function reduce_production(uuid, numeric, text) to pdp_app;
