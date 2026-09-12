-- 0070_import_historical_sales.sql — Importación de ventas históricas (Google Sheets → sistema).
-- Una venta histórica es un registro financiero del pasado: crea pedido + ítems + venta + pago en una
-- transacción, SIN mover inventario (el stock de hoy no cambia por ventas de hace meses) y SIN otorgar
-- puntos (el programa de fidelización empieza con el sistema). Idempotente por source_ref.

-- Idempotencia fuerte: un mismo source_ref de importación no puede producir dos pedidos.
create unique index if not exists orders_import_source_ref_idx on orders(source_ref) where source_ref like 'import:%';

-- payload:
-- {
--   source_ref: 'import:<clave>:<fila>'   (obligatorio, único; clave estable por archivo)
--   sold_at: timestamptz  | sold_date: 'YYYY-MM-DD' (se interpreta como mediodía en la zona horaria del negocio)
--                                          (si no viene ninguna: now())
--   channel?: 'pos'|'web'|'admin'|'instagram'|'whatsapp'   (default 'admin')
--   fulfillment_type?: 'pickup'|'scheduled_pickup'|'delivery'|'preorder'  (default 'pickup')
--   customer_id?: uuid, customer_name?: text, customer_phone?: text, customer_email?: text
--   pickup_point_id?: uuid, pickup_point_name?: text (se guarda como nota si no hay id)
--   paid?: boolean (default true). Si false: solo pedido confirmado con pago pendiente, sin venta ni pago.
--   payment_method?: 'cash'|'mercadopago'|'card_terminal'|'transfer'|'other'  (default 'cash')
--   payment_reference?: text
--   items: [{product_id, qty, unit_price_cents?, unit_cost_cents?, discount_cents?, notes?}]
--   discount_cents?, delivery_fee_cents?, tip_cents?
--   total_cents?: total declarado en la hoja. Si es menor a la suma calculada, la diferencia se
--                 registra como descuento; si es mayor, la fila falla (no inventamos cargos).
--   notes?, internal_notes?
-- }
-- Devuelve {order_id, sale_id, payment_id, folio, total_cents, paid, duplicate}
create or replace function import_historical_sale(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_source_ref text := nullif(btrim(coalesce(p->>'source_ref', '')), '');
  v_sold_at timestamptz;
  v_channel order_channel := coalesce(nullif(p->>'channel', '')::order_channel, 'admin');
  v_fulfillment fulfillment_type := coalesce(nullif(p->>'fulfillment_type', '')::fulfillment_type, 'pickup');
  v_paid boolean := coalesce((p->>'paid')::boolean, true);
  v_method payment_method := coalesce(nullif(p->>'payment_method', '')::payment_method, 'cash');
  v_provider payment_provider;
  v_customer_id uuid := jsonb_uuid(p, 'customer_id');
  v_cust customers%rowtype;
  v_order_id uuid;
  v_sale_id uuid;
  v_payment_id uuid;
  v_folio text;
  v_item jsonb;
  v_product products%rowtype;
  v_qty numeric;
  v_unit integer;
  v_cost integer;
  v_line_disc integer;
  v_line_total integer;
  v_subtotal integer := 0;
  v_discount integer := greatest(coalesce(jsonb_int(p, 'discount_cents', 0), 0), 0);
  v_fee integer := greatest(coalesce(jsonb_int(p, 'delivery_fee_cents', 0), 0), 0);
  v_tip integer := greatest(coalesce(jsonb_int(p, 'tip_cents', 0), 0), 0);
  v_declared integer := jsonb_int(p, 'total_cents');
  v_total integer;
  v_cost_total integer;
  v_all_costed boolean;
  v_items_count numeric;
  v_sort integer := 0;
  v_notes text := nullif(p->>'notes', '');
  v_internal text := nullif(p->>'internal_notes', '');
  v_pickup_id uuid := jsonb_uuid(p, 'pickup_point_id');
begin
  -- Fecha: timestamptz explícito, o fecha simple a mediodía local del negocio (evita que "12/03" caiga en el 11 por UTC).
  if nullif(p->>'sold_at', '') is not null then
    v_sold_at := (p->>'sold_at')::timestamptz;
  elsif nullif(p->>'sold_date', '') is not null then
    v_sold_at := ((p->>'sold_date')::date + time '12:00') at time zone (select timezone from business_settings where id = 1);
  else
    v_sold_at := now();
  end if;
  if v_sold_at > now() + interval '1 day' then
    raise exception 'La fecha de la venta (%) está en el futuro', v_sold_at using errcode = 'check_violation';
  end if;

  if v_source_ref is null or v_source_ref not like 'import:%' then
    raise exception 'source_ref obligatorio con formato import:<clave>:<fila>' using errcode = 'check_violation';
  end if;

  -- Idempotencia: misma fila importada dos veces devuelve el mismo pedido.
  select id, folio, total_cents into v_order_id, v_folio, v_total from orders where source_ref = v_source_ref;
  if v_order_id is not null then
    select id into v_sale_id from sales where order_id = v_order_id;
    select id into v_payment_id from payments where order_id = v_order_id order by created_at limit 1;
    return jsonb_build_object('order_id', v_order_id, 'sale_id', v_sale_id, 'payment_id', v_payment_id,
                              'folio', v_folio, 'total_cents', v_total, 'paid', v_sale_id is not null, 'duplicate', true);
  end if;

  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'La venta histórica necesita al menos un producto' using errcode = 'check_violation';
  end if;

  if v_customer_id is not null then
    select * into v_cust from customers where id = v_customer_id and deleted_at is null;
    if v_cust.id is null then raise exception 'Cliente % no existe', v_customer_id using errcode = 'foreign_key_violation'; end if;
    if v_cust.merged_into_id is not null then
      v_customer_id := v_cust.merged_into_id;
      select * into v_cust from customers where id = v_customer_id;
    end if;
  end if;

  if v_pickup_id is null and nullif(p->>'pickup_point_name', '') is not null then
    select id into v_pickup_id from pickup_points where lower(name) = lower(btrim(p->>'pickup_point_name')) limit 1;
    if v_pickup_id is null then
      v_internal := concat_ws(' · ', v_internal, 'Punto de entrega: ' || btrim(p->>'pickup_point_name'));
    end if;
  end if;

  -- Folio con el año de la venta (no el de hoy) para que el histórico se lea bien.
  v_folio := 'PDP-' || to_char(v_sold_at, 'YYYY') || '-' || lpad(nextval('order_folio_seq')::text, 6, '0');

  insert into orders(folio, channel, status, payment_status, fulfillment_type, customer_id, customer_name, customer_phone, customer_email,
                     pickup_point_id, notes, internal_notes, source_ref, created_by, placed_at,
                     subtotal_cents, discount_cents, delivery_fee_cents, tip_cents, tax_cents, total_cents)
  values (v_folio, v_channel, 'new', 'pending', v_fulfillment, v_customer_id,
          coalesce(nullif(p->>'customer_name', ''), v_cust.full_name), coalesce(nullif(p->>'customer_phone', ''), v_cust.phone::text),
          coalesce(nullif(p->>'customer_email', ''), v_cust.email::text),
          v_pickup_id, v_notes, v_internal, v_source_ref, current_staff_id(), v_sold_at,
          0, 0, v_fee, v_tip, 0, v_fee + v_tip)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p->'items') loop
    select * into v_product from products where id = (v_item->>'product_id')::uuid;
    if v_product.id is null then raise exception 'Producto % no existe', v_item->>'product_id' using errcode = 'foreign_key_violation'; end if;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Cantidad inválida para "%"', v_product.name using errcode = 'check_violation'; end if;
    -- Precio: el de la hoja si viene; si no, el vigente en la fecha de la venta.
    v_unit := coalesce((v_item->>'unit_price_cents')::integer,
                       current_price_cents(v_product.id, 'pos', v_sold_at),
                       current_price_cents(v_product.id, 'all', v_sold_at),
                       current_price_cents(v_product.id, 'pos'));
    if v_unit is null then raise exception 'Producto "%" sin precio (ni en la hoja ni en el catálogo)', v_product.name using errcode = 'check_violation'; end if;
    if v_unit < 0 then raise exception 'Precio negativo para "%"', v_product.name using errcode = 'check_violation'; end if;
    -- Costo: el de la hoja si viene; si no, el costeo de la receta en esa fecha (puede ser null).
    v_cost := coalesce((v_item->>'unit_cost_cents')::integer, product_cost_cents(v_product.id, v_sold_at));
    v_line_disc := greatest(coalesce((v_item->>'discount_cents')::integer, 0), 0);
    v_line_total := greatest(round(v_unit * v_qty)::integer - v_line_disc, 0);
    v_sort := v_sort + 1;
    insert into order_items(order_id, product_id, product_name, variant_label, qty, unit_price_cents, discount_cents, total_cents, unit_cost_cents, notes, sort_order)
    values (v_order_id, v_product.id, v_product.name, v_product.variant_label, v_qty, v_unit, v_line_disc, v_line_total, v_cost, nullif(v_item->>'notes', ''), v_sort);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  -- Total declarado en la hoja: conciliar con lo calculado.
  if v_declared is not null then
    if v_declared < 0 then raise exception 'Total declarado negativo' using errcode = 'check_violation'; end if;
    if v_declared < v_subtotal - v_discount + v_fee + v_tip then
      v_discount := v_subtotal + v_fee + v_tip - v_declared;
    elsif v_declared > v_subtotal - v_discount + v_fee + v_tip then
      raise exception 'El total declarado (%) es mayor a la suma de los ítems (%); revisa precios o cantidades',
        v_declared, v_subtotal - v_discount + v_fee + v_tip using errcode = 'check_violation';
    end if;
  end if;
  v_discount := least(v_discount, v_subtotal + v_fee + v_tip);
  v_total := v_subtotal - v_discount + v_fee + v_tip;

  update orders set subtotal_cents = v_subtotal, discount_cents = v_discount, total_cents = v_total where id = v_order_id;

  if not v_paid then
    update orders set status = 'confirmed', confirmed_at = v_sold_at where id = v_order_id;
    insert into order_status_history(order_id, from_status, to_status, note, staff_id, created_at)
    values (v_order_id, null, 'confirmed', 'Importado de Google Sheets (pago pendiente)', current_staff_id(), v_sold_at);
    perform emit_event('HISTORICAL_SALE_IMPORTED', 'order', v_order_id::text,
                       jsonb_build_object('source_ref', v_source_ref, 'total_cents', v_total, 'paid', false, 'customer_id', v_customer_id));
    return jsonb_build_object('order_id', v_order_id, 'sale_id', null, 'payment_id', null, 'folio', v_folio,
                              'total_cents', v_total, 'paid', false, 'duplicate', false);
  end if;

  -- Pago (solo si hubo monto; una venta de $0 no genera pago)
  if v_total > 0 then
    v_provider := case v_method when 'cash' then 'cash'::payment_provider when 'mercadopago' then 'mercadopago'::payment_provider else 'manual'::payment_provider end;
    insert into payments(order_id, provider, method, status, amount_cents, reference, idempotency_key, metadata, received_by, created_at, confirmed_at)
    values (v_order_id, v_provider, v_method, 'paid', v_total, nullif(p->>'payment_reference', ''), v_source_ref,
            jsonb_build_object('imported', true, 'source_ref', v_source_ref), current_staff_id(), v_sold_at, v_sold_at)
    returning id into v_payment_id;
  end if;

  -- Venta (registro financiero inmutable). Sin inventario, sin puntos, sin cupones.
  select sum(round(coalesce(unit_cost_cents, 0) * qty))::integer, bool_and(unit_cost_cents is not null), sum(qty)
    into v_cost_total, v_all_costed, v_items_count from order_items where order_id = v_order_id;
  insert into sales(order_id, channel, customer_id, staff_id, sold_at, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, cost_cents, items_count)
  values (v_order_id, v_channel, v_customer_id, current_staff_id(), v_sold_at, v_subtotal, v_discount, 0, v_tip, v_total,
          case when v_all_costed then v_cost_total else null end, coalesce(v_items_count, 0))
  returning id into v_sale_id;

  update orders set status = 'completed', payment_status = 'paid', paid_cents = v_total, paid_at = v_sold_at,
         confirmed_at = v_sold_at, completed_at = v_sold_at where id = v_order_id;
  insert into order_status_history(order_id, from_status, to_status, note, staff_id, created_at)
  values (v_order_id, null, 'completed', 'Importado de Google Sheets', current_staff_id(), v_sold_at);

  -- Estadísticas del cliente (respetando fechas históricas). Sin puntos.
  if v_customer_id is not null then
    update customers set total_orders = total_orders + 1, total_spent_cents = total_spent_cents + v_total,
           first_purchase_at = least(coalesce(first_purchase_at, v_sold_at), v_sold_at),
           last_purchase_at = greatest(coalesce(last_purchase_at, v_sold_at), v_sold_at)
     where id = v_customer_id;
    perform recompute_customer_tier(v_customer_id);
  end if;

  perform emit_event('HISTORICAL_SALE_IMPORTED', 'order', v_order_id::text,
                     jsonb_build_object('source_ref', v_source_ref, 'sale_id', v_sale_id, 'total_cents', v_total, 'paid', true,
                                        'sold_at', v_sold_at, 'customer_id', v_customer_id));
  return jsonb_build_object('order_id', v_order_id, 'sale_id', v_sale_id, 'payment_id', v_payment_id, 'folio', v_folio,
                            'total_cents', v_total, 'paid', true, 'duplicate', false);
end $$;
