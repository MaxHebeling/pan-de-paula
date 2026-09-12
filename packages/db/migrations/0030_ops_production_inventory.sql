-- 0030_ops_production_inventory.sql — Operación diaria: deshacer lote, corrección de stock, wizard de conteo, alertas de stock.
-- Aditiva. Todo lo que toca inventario sigue pasando por inventory_movements (append-only).

-- ── Deshacer producción (ventana de 2 minutos) ──────────────────────────────
alter table production_batches add column if not exists undone_at timestamptz;

-- Revierte un lote recién registrado con un movimiento CORRECTION negativo que referencia al lote.
-- No borra nada: el lote queda marcado (undone_at) y el historial conserva ambos movimientos.
create or replace function undo_production(p_batch_id uuid, p_note text default 'deshacer')
returns bigint language plpgsql as $$
declare
  b production_batches%rowtype;
  v_movement_id bigint;
  it record;
begin
  select * into b from production_batches where id = p_batch_id for update;
  if b.id is null then raise exception 'Lote no existe'; end if;
  if b.undone_at is not null then
    raise exception 'Este lote ya fue deshecho' using errcode = 'check_violation';
  end if;
  if b.created_at < now() - interval '2 minutes' then
    raise exception 'Solo se puede deshacer un lote durante los 2 minutos siguientes a su registro' using errcode = 'check_violation';
  end if;
  insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, note, staff_id)
  values (b.product_id, 'CORRECTION', -b.qty, 'production_batch', b.id::text, 'undo', coalesce(nullif(p_note, ''), 'deshacer'), current_staff_id())
  returning id into v_movement_id;
  -- Devuelve los insumos que se descontaron con el lote
  if b.ingredients_consumed then
    for it in select ingredient_id, qty from ingredient_movements
              where ref_type = 'production_batch' and ref_id = b.id::text and type = 'CONSUMPTION' loop
      insert into ingredient_movements(ingredient_id, type, qty, ref_type, ref_id, note, staff_id)
      values (it.ingredient_id, 'CORRECTION', -it.qty, 'production_batch', b.id::text, 'deshacer lote ' || b.lot_code, current_staff_id());
    end loop;
  end if;
  update production_batches set undone_at = now() where id = b.id;
  perform emit_event('PRODUCTION_UNDONE', 'product', b.product_id::text,
                     jsonb_build_object('qty', b.qty, 'batch_id', b.id, 'movement_id', v_movement_id));
  return v_movement_id;
end $$;

-- ── Corrección manual de stock (ajuste rápido) ──────────────────────────────
-- p_delta: + suma, − resta. Motivos acotados; la merma real va por record_waste.
create or replace function record_stock_correction(p_product_id uuid, p_delta numeric, p_reason text, p_note text default null)
returns bigint language plpgsql as $$
declare
  v_id bigint;
  bs business_settings%rowtype;
  v_on_hand numeric;
begin
  if p_delta is null or p_delta = 0 then raise exception 'La corrección no puede ser cero' using errcode = 'check_violation'; end if;
  if p_reason not in ('difference', 'error', 'initial', 'other') then
    raise exception 'Motivo de corrección inválido: %', p_reason using errcode = 'check_violation';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then raise exception 'Producto no existe'; end if;
  select * into bs from business_settings where id = 1;
  insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, note, staff_id)
  values (p_product_id, (case when p_reason = 'initial' then 'INITIAL' else 'CORRECTION' end)::movement_type,
          p_delta, 'manual', null, p_reason, nullif(p_note, ''), current_staff_id())
  returning id into v_id;
  select coalesce(on_hand, 0) into v_on_hand from inventory_levels where product_id = p_product_id;
  if v_on_hand > bs.low_stock_threshold then
    update notifications set read_at = now()
     where entity = 'product' and entity_id = p_product_id::text and read_at is null and kind in ('low_stock', 'out_of_stock');
  end if;
  perform emit_event('STOCK_CORRECTED', 'product', p_product_id::text,
                     jsonb_build_object('delta', p_delta, 'reason', p_reason, 'movement_id', v_id));
  return v_id;
end $$;

-- ── Conteo físico: wizard ───────────────────────────────────────────────────
-- Crea el conteo con TODOS los productos activos con control de stock, esperado = nivel actual, contado = esperado.
create or replace function create_stock_count(p_notes text default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  if exists (select 1 from stock_counts where status = 'open') then
    raise exception 'Ya hay un conteo abierto; aplícalo o descártalo antes de iniciar otro' using errcode = 'check_violation';
  end if;
  insert into stock_counts(staff_id, notes) values (current_staff_id(), nullif(p_notes, '')) returning id into v_id;
  insert into stock_count_items(stock_count_id, product_id, expected_qty, counted_qty)
  select v_id, p.id, coalesce(l.on_hand, 0), coalesce(l.on_hand, 0)
  from products p left join inventory_levels l on l.product_id = p.id
  where p.deleted_at is null and p.is_active and p.track_stock;
  perform emit_event('STOCK_COUNT_STARTED', 'stock_count', v_id::text, jsonb_build_object('items', (select count(*) from stock_count_items where stock_count_id = v_id)));
  return v_id;
end $$;

-- Captura la cantidad contada de un producto (upsert; si el producto no estaba, toma el nivel actual como esperado).
create or replace function set_stock_count_item(p_stock_count_id uuid, p_product_id uuid, p_counted_qty numeric, p_note text default null)
returns void language plpgsql as $$
declare sc stock_counts%rowtype;
begin
  select * into sc from stock_counts where id = p_stock_count_id for update;
  if sc.id is null then raise exception 'Conteo no existe'; end if;
  if sc.status <> 'open' then raise exception 'El conteo ya fue cerrado' using errcode = 'check_violation'; end if;
  if p_counted_qty is null or p_counted_qty < 0 then raise exception 'Cantidad contada inválida' using errcode = 'check_violation'; end if;
  insert into stock_count_items(stock_count_id, product_id, expected_qty, counted_qty, note)
  values (p_stock_count_id, p_product_id, coalesce((select on_hand from inventory_levels where product_id = p_product_id), 0), p_counted_qty, nullif(p_note, ''))
  on conflict (stock_count_id, product_id) do update set counted_qty = excluded.counted_qty, note = coalesce(excluded.note, stock_count_items.note);
end $$;

create or replace function discard_stock_count(p_stock_count_id uuid) returns void
language plpgsql as $$
declare sc stock_counts%rowtype;
begin
  select * into sc from stock_counts where id = p_stock_count_id for update;
  if sc.id is null then raise exception 'Conteo no existe'; end if;
  if sc.status <> 'open' then return; end if;
  update stock_counts set status = 'discarded', closed_at = now() where id = p_stock_count_id;
  perform emit_event('STOCK_COUNT_DISCARDED', 'stock_count', p_stock_count_id::text, '{}'::jsonb);
end $$;

-- ── Alertas de stock (cron) ─────────────────────────────────────────────────
-- Crea notificaciones de stock bajo/agotado e insumos críticos SIN duplicar las abiertas (read_at is null)
-- y cierra las que ya no aplican. Devuelve el resumen para job_runs.result.
create or replace function run_stock_alerts() returns jsonb
language plpgsql as $$
declare
  v_low integer := 0;
  v_out integer := 0;
  v_ing integer := 0;
  v_closed integer := 0;
  v_upgraded integer := 0;
begin
  -- Cierra alertas de producto que ya se repuso
  with closed as (
    update notifications n set read_at = now()
    from stock_status s
    where n.entity = 'product' and n.entity_id = s.product_id::text and n.read_at is null
      and n.kind in ('low_stock', 'out_of_stock') and s.level = 'ok'
    returning 1)
  select count(*) into v_closed from closed;
  -- Cierra alertas de insumo repuesto
  with closed as (
    update notifications n set read_at = now()
    from ingredients i
    where n.entity = 'ingredient' and n.entity_id = i.id::text and n.read_at is null and n.kind = 'ingredient_low'
      and (i.stock_qty > i.min_stock_qty or i.min_stock_qty <= 0 or i.deleted_at is not null)
    returning 1)
  select v_closed + count(*) into v_closed from closed;
  -- Un producto que pasó de "bajo" a "agotado": cierra la de bajo para emitir la de agotado
  with up as (
    update notifications n set read_at = now()
    from stock_status s
    where n.entity = 'product' and n.entity_id = s.product_id::text and n.read_at is null
      and n.kind = 'low_stock' and s.level = 'out'
    returning 1)
  select count(*) into v_upgraded from up;

  with ins as (
    insert into notifications(kind, severity, title, body, entity, entity_id)
    select 'out_of_stock', 'warning', 'Producto agotado', s.name || ': quedan ' || s.on_hand::text, 'product', s.product_id::text
    from stock_status s
    where s.track_stock and s.level = 'out'
      and not exists (select 1 from notifications n where n.entity = 'product' and n.entity_id = s.product_id::text and n.read_at is null and n.kind in ('low_stock', 'out_of_stock'))
    returning 1)
  select count(*) into v_out from ins;

  with ins as (
    insert into notifications(kind, severity, title, body, entity, entity_id)
    select 'low_stock', 'warning', 'Stock bajo', s.name || ': quedan ' || s.on_hand::text, 'product', s.product_id::text
    from stock_status s
    where s.track_stock and s.level = 'low'
      and not exists (select 1 from notifications n where n.entity = 'product' and n.entity_id = s.product_id::text and n.read_at is null and n.kind in ('low_stock', 'out_of_stock'))
    returning 1)
  select count(*) into v_low from ins;

  with ins as (
    insert into notifications(kind, severity, title, body, entity, entity_id)
    select 'ingredient_low', 'warning', 'Insumo crítico', i.name || ': quedan ' || i.stock_qty::text || ' ' || i.base_unit::text || ' (mínimo ' || i.min_stock_qty::text || ')', 'ingredient', i.id::text
    from ingredients i
    where i.deleted_at is null and i.min_stock_qty > 0 and i.stock_qty <= i.min_stock_qty
      and not exists (select 1 from notifications n where n.entity = 'ingredient' and n.entity_id = i.id::text and n.read_at is null and n.kind = 'ingredient_low')
    returning 1)
  select count(*) into v_ing from ins;

  return jsonb_build_object('low_stock', v_low, 'out_of_stock', v_out, 'ingredient_low', v_ing, 'closed', v_closed, 'upgraded', v_upgraded);
end $$;
