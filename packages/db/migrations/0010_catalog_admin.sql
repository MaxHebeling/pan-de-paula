-- 0010_catalog_admin.sql — Funciones de apoyo para el módulo Catálogo / Recetas / Precios del admin.
-- Aditiva. No crea tablas. Todo corre con los privilegios del invocador (pdp_app) y respeta current_staff_id().

-- ¿El producto (o alguna de sus variantes) aparece en ventas/pedidos? Si sí, no se borra: solo se desactiva.
create or replace function product_has_sales(p_product_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from order_items oi
    where oi.product_id = p_product_id
       or oi.product_id in (select id from products where parent_id = p_product_id)
  )
$$;

-- Impacto de un nuevo costo unitario de insumo sobre los productos que lo usan en su receta.
-- Devuelve costo actual y costo nuevo por pieza (centavos) para previsualizar antes de registrar el precio.
create or replace function product_cost_impact(p_ingredient_id uuid, p_new_unit_cost numeric)
returns table (
  product_id uuid,
  product_name text,
  current_cost_cents integer,
  new_cost_cents integer
) language sql stable as $$
  with affected as (
    select r.id as recipe_id, r.product_id, p.name, r.yield_qty, r.labor_cents, r.overhead_cents
    from recipes r
    join products p on p.id = r.product_id and p.deleted_at is null
    where exists (select 1 from recipe_items ri where ri.recipe_id = r.id and ri.ingredient_id = p_ingredient_id)
  ),
  costs as (
    select a.product_id, a.name, a.yield_qty, a.labor_cents, a.overhead_cents,
           coalesce(sum(ri.qty * coalesce(ingredient_unit_cost(ri.ingredient_id), 0)), 0) as cur_ing,
           coalesce(sum(ri.qty * case when ri.ingredient_id = p_ingredient_id then p_new_unit_cost
                                      else coalesce(ingredient_unit_cost(ri.ingredient_id), 0) end), 0) as new_ing
    from affected a
    join recipe_items ri on ri.recipe_id = a.recipe_id
    group by a.product_id, a.name, a.yield_qty, a.labor_cents, a.overhead_cents
  )
  select product_id, name,
         round(((cur_ing * 100) + labor_cents + overhead_cents) / yield_qty)::integer,
         round(((new_ing * 100) + labor_cents + overhead_cents) / yield_qty)::integer
  from costs
  order by name
$$;

-- Nuevo precio regular: cierra el regular vigente del mismo canal (valid_to = now()) e inserta el nuevo.
-- Nunca modifica el precio histórico más allá de fijarle su fin de vigencia.
create or replace function set_regular_price(
  p_product_id uuid,
  p_channel price_channel,
  p_price_cents integer,
  p_label text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'El precio debe ser mayor o igual a cero';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  update product_prices
     set valid_to = v_now
   where product_id = p_product_id and channel = p_channel and kind = 'regular'
     and valid_from < v_now and (valid_to is null or valid_to > v_now);
  -- Precios regulares programados a futuro para el mismo canal quedan sin efecto (nunca fueron vigentes).
  delete from product_prices
   where product_id = p_product_id and channel = p_channel and kind = 'regular' and valid_from >= v_now;
  insert into product_prices(product_id, channel, kind, price_cents, valid_from, label, created_by)
  values (p_product_id, p_channel, 'regular', p_price_cents, v_now, nullif(trim(p_label), ''), current_staff_id())
  returning id into v_id;
  perform emit_event('PRICE_CHANGED', 'product', p_product_id::text,
    jsonb_build_object('price_id', v_id, 'channel', p_channel, 'kind', 'regular', 'price_cents', p_price_cents));
  return v_id;
end $$;

-- Crea una promoción con vigencia. Debe ser menor al precio regular vigente del canal (si existe).
create or replace function create_promotion(
  p_product_id uuid,
  p_channel price_channel,
  p_price_cents integer,
  p_valid_from timestamptz,
  p_valid_to timestamptz,
  p_label text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_regular integer;
begin
  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'El precio debe ser mayor o igual a cero';
  end if;
  if p_valid_to is not null and p_valid_to <= p_valid_from then
    raise exception 'La fecha de fin debe ser posterior al inicio';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  select price_cents into v_regular from product_prices
   where product_id = p_product_id and kind = 'regular' and (channel = p_channel or channel = 'all')
     and valid_from <= greatest(p_valid_from, now()) and (valid_to is null or valid_to > greatest(p_valid_from, now()))
   order by case when channel = p_channel then 0 else 1 end, valid_from desc limit 1;
  if v_regular is not null and p_price_cents >= v_regular then
    raise exception 'La promoción (%) debe ser menor al precio regular vigente (%)', p_price_cents, v_regular;
  end if;
  insert into product_prices(product_id, channel, kind, price_cents, valid_from, valid_to, label, created_by)
  values (p_product_id, p_channel, 'promo', p_price_cents, coalesce(p_valid_from, now()), p_valid_to, nullif(trim(p_label), ''), current_staff_id())
  returning id into v_id;
  perform emit_event('PROMO_CREATED', 'product', p_product_id::text,
    jsonb_build_object('price_id', v_id, 'channel', p_channel, 'price_cents', p_price_cents, 'valid_from', p_valid_from, 'valid_to', p_valid_to));
  return v_id;
end $$;

-- Termina una promoción anticipadamente. Si aún no había iniciado, se elimina (nunca fue vigente).
create or replace function end_promotion(p_price_id uuid) returns void language plpgsql as $$
declare
  v_row product_prices%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_row from product_prices where id = p_price_id and kind = 'promo';
  if not found then
    raise exception 'Promoción no encontrada';
  end if;
  if v_row.valid_to is not null and v_row.valid_to <= v_now then
    raise exception 'La promoción ya terminó';
  end if;
  if v_row.valid_from > v_now then
    delete from product_prices where id = p_price_id;
  else
    update product_prices set valid_to = v_now where id = p_price_id;
  end if;
  perform emit_event('PROMO_ENDED', 'product', v_row.product_id::text, jsonb_build_object('price_id', p_price_id));
end $$;

-- Reemplaza la receta completa de un producto (cabecera + líneas) en una sola transacción.
-- p_items: [{ingredient_id, qty, note}] con qty en unidad base del ingrediente.
create or replace function upsert_recipe(
  p_product_id uuid,
  p_yield_qty numeric,
  p_yield_label text,
  p_labor_cents integer,
  p_overhead_cents integer,
  p_notes text,
  p_items jsonb
) returns uuid language plpgsql as $$
declare
  v_recipe_id uuid;
  v_item jsonb;
  v_i integer := 0;
begin
  if p_yield_qty is null or p_yield_qty <= 0 then
    raise exception 'El rendimiento debe ser mayor a cero';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  insert into recipes(product_id, yield_qty, yield_label, labor_cents, overhead_cents, notes)
  values (p_product_id, p_yield_qty, nullif(trim(p_yield_label), ''), coalesce(p_labor_cents, 0), coalesce(p_overhead_cents, 0), nullif(trim(p_notes), ''))
  on conflict (product_id) do update
    set yield_qty = excluded.yield_qty,
        yield_label = excluded.yield_label,
        labor_cents = excluded.labor_cents,
        overhead_cents = excluded.overhead_cents,
        notes = excluded.notes,
        version = recipes.version + 1
  returning id into v_recipe_id;
  delete from recipe_items where recipe_id = v_recipe_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if (v_item->>'qty')::numeric <= 0 then
      raise exception 'La cantidad de cada ingrediente debe ser mayor a cero';
    end if;
    insert into recipe_items(recipe_id, ingredient_id, qty, note, sort_order)
    values (v_recipe_id, (v_item->>'ingredient_id')::uuid, (v_item->>'qty')::numeric, nullif(trim(v_item->>'note'), ''), v_i);
    v_i := v_i + 1;
  end loop;
  perform emit_event('RECIPE_UPDATED', 'product', p_product_id::text,
    jsonb_build_object('recipe_id', v_recipe_id, 'items', v_i, 'cost_per_piece_cents', product_cost_cents(p_product_id)));
  return v_recipe_id;
end $$;

-- Registra un precio de compra de insumo (historial) y opcionalmente el movimiento de compra que suma stock.
create or replace function record_ingredient_price(
  p_ingredient_id uuid,
  p_package_qty numeric,
  p_price_cents integer,
  p_package_label text default null,
  p_supplier_id uuid default null,
  p_add_stock boolean default false,
  p_packages numeric default 1
) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  if p_package_qty is null or p_package_qty <= 0 then
    raise exception 'El contenido del empaque debe ser mayor a cero';
  end if;
  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'El precio debe ser mayor o igual a cero';
  end if;
  if not exists (select 1 from ingredients where id = p_ingredient_id and deleted_at is null) then
    raise exception 'Ingrediente no encontrado';
  end if;
  insert into ingredient_prices(ingredient_id, supplier_id, package_label, package_qty, price_cents, source, created_by)
  values (p_ingredient_id, p_supplier_id, nullif(trim(p_package_label), ''), p_package_qty, p_price_cents,
          case when p_add_stock then 'purchase' else 'manual' end, current_staff_id())
  returning id into v_id;
  if p_add_stock then
    if p_packages is null or p_packages <= 0 then
      raise exception 'La cantidad de empaques comprados debe ser mayor a cero';
    end if;
    insert into ingredient_movements(ingredient_id, type, qty, ref_type, ref_id, note, staff_id)
    values (p_ingredient_id, 'PURCHASE', p_package_qty * p_packages, 'ingredient_price', v_id::text,
            'Compra de ' || p_packages || ' × ' || coalesce(nullif(trim(p_package_label), ''), p_package_qty::text), current_staff_id());
  end if;
  perform emit_event('INGREDIENT_PRICE_RECORDED', 'ingredient', p_ingredient_id::text,
    jsonb_build_object('price_id', v_id, 'price_cents', p_price_cents, 'package_qty', p_package_qty));
  return v_id;
end $$;
