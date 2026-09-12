-- 0008_transactions.sql — Operaciones transaccionales del negocio.
-- Todo lo que toca dinero, inventario y puntos ocurre aquí, en una sola transacción, de forma idempotente.

-- ── Utilidades ──────────────────────────────────────────────────────────────
create or replace function jsonb_int(p jsonb, k text, d integer default null) returns integer
language sql immutable as $$ select coalesce((p->>k)::integer, d) $$;

create or replace function jsonb_uuid(p jsonb, k text) returns uuid
language sql immutable as $$ select nullif(p->>k, '')::uuid $$;

-- ── Puntos ──────────────────────────────────────────────────────────────────
-- Calcula los puntos a otorgar por una venta (regla configurable + bonos por producto + cumpleaños).
create or replace function loyalty_points_for(p_customer_id uuid, p_total_cents integer, p_order_id uuid, p_at timestamptz default now())
returns integer language plpgsql stable as $$
declare
  prog loyalty_program%rowtype;
  v_points numeric := 0;
  v_bonus integer := 0;
  v_birthday boolean := false;
  v_flag boolean;
begin
  select enabled into v_flag from feature_flags where key = 'loyalty';
  if p_customer_id is null or coalesce(v_flag, false) = false then return 0; end if;
  select * into prog from loyalty_program where id = 1;
  if not prog.is_active or p_total_cents < prog.min_purchase_cents then return 0; end if;

  v_points := (p_total_cents::numeric / prog.unit_cents) * prog.points_per_unit;
  v_points := case when prog.rounding = 'round' then round(v_points) else floor(v_points) end;

  select coalesce(sum(b.bonus_points * oi.qty), 0)::integer into v_bonus
  from order_items oi join loyalty_product_bonuses b on b.product_id = oi.product_id and b.is_active
  where oi.order_id = p_order_id;

  select (c.birthday is not null
          and extract(month from c.birthday) = extract(month from p_at at time zone (select timezone from business_settings where id = 1))
          and extract(day from c.birthday) = extract(day from p_at at time zone (select timezone from business_settings where id = 1)))
    into v_birthday from customers c where c.id = p_customer_id;

  if coalesce(v_birthday, false) then
    v_points := floor(v_points * prog.birthday_multiplier);
  end if;
  return greatest(0, v_points::integer + v_bonus);
end $$;

-- Ledger de puntos con saldo consistente (bloquea la fila del cliente).
create or replace function loyalty_post(p_customer_id uuid, p_kind loyalty_tx_kind, p_points integer, p_sale_id uuid default null, p_redemption_id uuid default null, p_note text default null)
returns integer language plpgsql as $$
declare
  v_balance integer;
begin
  if p_points = 0 then
    select points_balance into v_balance from customers where id = p_customer_id;
    return v_balance;
  end if;
  select points_balance into v_balance from customers where id = p_customer_id for update;
  if v_balance is null then raise exception 'Cliente % no existe', p_customer_id; end if;
  if v_balance + p_points < 0 then
    raise exception 'Puntos insuficientes: saldo %, requeridos %', v_balance, -p_points using errcode = 'check_violation';
  end if;
  v_balance := v_balance + p_points;
  update customers set points_balance = v_balance,
         lifetime_points = lifetime_points + greatest(p_points, 0)
   where id = p_customer_id;
  insert into loyalty_transactions(customer_id, kind, points, balance_after, sale_id, redemption_id, note, staff_id)
  values (p_customer_id, p_kind, p_points, v_balance, p_sale_id, p_redemption_id, p_note, current_staff_id());
  return v_balance;
end $$;

create or replace function recompute_customer_tier(p_customer_id uuid) returns text
language plpgsql as $$
declare
  c customers%rowtype;
  v_tier text;
  v_old text;
begin
  select * into c from customers where id = p_customer_id;
  if c.id is null then return null; end if;
  v_old := c.tier_key;
  select key into v_tier from loyalty_tiers t
  where c.total_orders >= t.min_orders and c.total_spent_cents >= t.min_spent_cents and c.lifetime_points >= t.min_lifetime_points
  order by t.rank desc limit 1;
  if v_tier is distinct from v_old then
    update customers set tier_key = v_tier where id = p_customer_id;
    if v_old is not null and (select rank from loyalty_tiers where key = v_tier) > (select rank from loyalty_tiers where key = v_old) then
      insert into customer_events(customer_id, kind, payload) values (p_customer_id, 'tier_up', jsonb_build_object('from', v_old, 'to', v_tier))
      on conflict do nothing;
      if v_tier = 'vip' then
        insert into notifications(kind, severity, title, body, entity, entity_id)
        values ('new_vip', 'success', 'Nuevo cliente VIP', c.full_name || ' alcanzó nivel VIP', 'customer', c.id::text);
      end if;
    end if;
  end if;
  return v_tier;
end $$;

-- ── Cupones ─────────────────────────────────────────────────────────────────
create or replace function validate_coupon(p_code text, p_customer_id uuid, p_subtotal_cents integer, p_channel price_channel, p_items jsonb default '[]'::jsonb)
returns jsonb language plpgsql stable as $$
declare
  cp coupons%rowtype;
  v_uses integer;
  v_disc integer := 0;
  v_tier text;
  v_prod_total integer;
begin
  if p_code is null or btrim(p_code) = '' then return jsonb_build_object('valid', false, 'reason', 'empty'); end if;
  select * into cp from coupons where code = btrim(p_code)::citext;
  if cp.id is null then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;
  if not cp.is_active then return jsonb_build_object('valid', false, 'reason', 'inactive'); end if;
  if cp.starts_at is not null and cp.starts_at > now() then return jsonb_build_object('valid', false, 'reason', 'not_started'); end if;
  if cp.ends_at is not null and cp.ends_at < now() then return jsonb_build_object('valid', false, 'reason', 'expired'); end if;
  if cp.max_uses is not null and cp.uses_count >= cp.max_uses then return jsonb_build_object('valid', false, 'reason', 'exhausted'); end if;
  if not (cp.channels @> array['all'::price_channel] or cp.channels @> array[p_channel]) then
    return jsonb_build_object('valid', false, 'reason', 'channel');
  end if;
  if p_subtotal_cents < cp.min_subtotal_cents then
    return jsonb_build_object('valid', false, 'reason', 'min_subtotal', 'min_subtotal_cents', cp.min_subtotal_cents);
  end if;
  if p_customer_id is not null then
    select count(*) into v_uses from coupon_redemptions where coupon_id = cp.id and customer_id = p_customer_id;
    if v_uses >= cp.max_uses_per_customer then return jsonb_build_object('valid', false, 'reason', 'customer_limit'); end if;
    select tier_key into v_tier from customers where id = p_customer_id;
    if cp.segment ? 'tiers' and not (cp.segment->'tiers') ? coalesce(v_tier, 'new') then
      return jsonb_build_object('valid', false, 'reason', 'segment');
    end if;
    if coalesce((cp.segment->>'new_customers_only')::boolean, false) and exists (select 1 from sales where customer_id = p_customer_id) then
      return jsonb_build_object('valid', false, 'reason', 'segment');
    end if;
  elsif cp.segment <> '{}'::jsonb then
    return jsonb_build_object('valid', false, 'reason', 'requires_customer');
  end if;

  if cp.kind = 'pct' then
    if cp.product_id is not null then
      select coalesce(sum((i->>'total_cents')::integer), 0) into v_prod_total
      from jsonb_array_elements(p_items) i where (i->>'product_id')::uuid = cp.product_id;
      v_disc := round(v_prod_total * cp.value_bps / 10000.0);
    else
      v_disc := round(p_subtotal_cents * cp.value_bps / 10000.0);
    end if;
  elsif cp.kind = 'amount' then
    v_disc := least(cp.value_cents, p_subtotal_cents);
  elsif cp.kind = 'free_product' then
    select coalesce(min((i->>'unit_price_cents')::integer), 0) into v_disc
    from jsonb_array_elements(p_items) i where (i->>'product_id')::uuid = cp.product_id;
    if v_disc = 0 then return jsonb_build_object('valid', false, 'reason', 'product_not_in_cart'); end if;
  end if;
  v_disc := least(greatest(v_disc, 0), p_subtotal_cents);
  return jsonb_build_object('valid', true, 'coupon_id', cp.id, 'code', cp.code, 'kind', cp.kind, 'discount_cents', v_disc);
end $$;

-- ── Crear pedido (precios calculados en servidor) ───────────────────────────
-- payload: {channel, fulfillment_type, price_channel?, customer_id?, customer_name?, customer_phone?, customer_email?,
--           pickup_point_id?, delivery_address?, scheduled_for?, ordering_window_id?, notes?, source_ref?,
--           items:[{product_id, qty, unit_price_cents?, discount_cents?, notes?}], coupon_code?, reward_redemption_id?,
--           delivery_fee_cents?, tip_cents?, idempotency_key?, created_by?, allow_price_override?}
create or replace function create_order(p jsonb) returns uuid
language plpgsql as $$
declare
  v_order_id uuid;
  v_channel order_channel := (p->>'channel')::order_channel;
  v_price_channel price_channel := coalesce((p->>'price_channel')::price_channel, (case when (p->>'channel') = 'pos' then 'pos' else 'web' end)::price_channel);
  v_customer_id uuid := jsonb_uuid(p, 'customer_id');
  v_item jsonb;
  v_product products%rowtype;
  v_unit integer;
  v_qty numeric;
  v_line_disc integer;
  v_line_total integer;
  v_subtotal integer := 0;
  v_discount integer := 0;
  v_items_json jsonb := '[]'::jsonb;
  v_coupon jsonb;
  v_coupon_id uuid;
  v_coupon_code text;
  v_reward reward_redemptions%rowtype;
  v_reward_disc integer := 0;
  v_fee integer := coalesce(jsonb_int(p, 'delivery_fee_cents', 0), 0);
  v_tip integer := coalesce(jsonb_int(p, 'tip_cents', 0), 0);
  v_tax integer := 0;
  v_total integer;
  bs business_settings%rowtype;
  v_allow_override boolean := coalesce((p->>'allow_price_override')::boolean, false);
  v_idem text := nullif(p->>'idempotency_key', '');
  v_sort integer := 0;
  v_cust customers%rowtype;
begin
  if v_idem is not null then
    select id into v_order_id from orders where idempotency_key = v_idem;
    if v_order_id is not null then return v_order_id; end if;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'El pedido necesita al menos un producto' using errcode = 'check_violation';
  end if;
  select * into bs from business_settings where id = 1;

  if v_customer_id is not null then
    select * into v_cust from customers where id = v_customer_id and deleted_at is null;
    if v_cust.id is null then raise exception 'Cliente no encontrado' using errcode = 'foreign_key_violation'; end if;
    if v_cust.merged_into_id is not null then v_customer_id := v_cust.merged_into_id; end if;
  end if;

  insert into orders(channel, fulfillment_type, customer_id, customer_name, customer_phone, customer_email,
                     pickup_point_id, delivery_address, scheduled_for, ordering_window_id, notes, source_ref,
                     created_by, idempotency_key, delivery_fee_cents, tip_cents, subtotal_cents, discount_cents, tax_cents, total_cents)
  values (v_channel, coalesce((p->>'fulfillment_type')::fulfillment_type, 'pickup'), v_customer_id,
          coalesce(nullif(p->>'customer_name',''), v_cust.full_name), coalesce(nullif(p->>'customer_phone',''), v_cust.phone::text),
          coalesce(nullif(p->>'customer_email',''), v_cust.email::text),
          jsonb_uuid(p, 'pickup_point_id'), p->'delivery_address', nullif(p->>'scheduled_for','')::timestamptz,
          jsonb_uuid(p, 'ordering_window_id'), nullif(p->>'notes',''), nullif(p->>'source_ref',''),
          coalesce(jsonb_uuid(p, 'created_by'), current_staff_id()), v_idem, v_fee, v_tip, 0, 0, 0, v_fee + v_tip)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p->'items') loop
    select * into v_product from products where id = (v_item->>'product_id')::uuid and deleted_at is null;
    if v_product.id is null then raise exception 'Producto % no existe', v_item->>'product_id' using errcode = 'foreign_key_violation'; end if;
    if not v_product.is_active then raise exception 'Producto "%" no está disponible', v_product.name using errcode = 'check_violation'; end if;
    if v_channel = 'web' and not v_product.show_on_web then raise exception 'Producto "%" no se vende en línea', v_product.name using errcode = 'check_violation'; end if;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Cantidad inválida para %', v_product.name using errcode = 'check_violation'; end if;
    v_unit := current_price_cents(v_product.id, v_price_channel);
    if v_allow_override and (v_item ? 'unit_price_cents') then v_unit := (v_item->>'unit_price_cents')::integer; end if;
    if v_unit is null then raise exception 'Producto "%" no tiene precio configurado', v_product.name using errcode = 'check_violation'; end if;
    v_line_disc := coalesce((v_item->>'discount_cents')::integer, 0);
    if v_line_disc < 0 then v_line_disc := 0; end if;
    v_line_total := greatest(round(v_unit * v_qty)::integer - v_line_disc, 0);
    v_sort := v_sort + 1;
    insert into order_items(order_id, product_id, product_name, variant_label, qty, unit_price_cents, discount_cents, total_cents, unit_cost_cents, notes, sort_order)
    values (v_order_id, v_product.id, v_product.name, v_product.variant_label, v_qty, v_unit, v_line_disc, v_line_total,
            product_cost_cents(v_product.id), nullif(v_item->>'notes',''), v_sort);
    v_subtotal := v_subtotal + v_line_total;
    v_items_json := v_items_json || jsonb_build_object('product_id', v_product.id, 'qty', v_qty, 'unit_price_cents', v_unit, 'total_cents', v_line_total);
  end loop;

  -- Cupón
  if nullif(p->>'coupon_code','') is not null then
    v_coupon := validate_coupon(p->>'coupon_code', v_customer_id, v_subtotal, v_price_channel, v_items_json);
    if not (v_coupon->>'valid')::boolean then
      raise exception 'Cupón inválido: %', v_coupon->>'reason' using errcode = 'check_violation';
    end if;
    v_coupon_id := (v_coupon->>'coupon_id')::uuid;
    v_coupon_code := v_coupon->>'code';
    v_discount := v_discount + (v_coupon->>'discount_cents')::integer;
  end if;

  -- Recompensa canjeada (ya emitida)
  if jsonb_uuid(p, 'reward_redemption_id') is not null then
    select * into v_reward from reward_redemptions where id = jsonb_uuid(p, 'reward_redemption_id') for update;
    if v_reward.id is null or v_reward.status <> 'issued' then raise exception 'Recompensa no disponible' using errcode = 'check_violation'; end if;
    if v_customer_id is null or v_reward.customer_id <> v_customer_id then raise exception 'La recompensa pertenece a otro cliente' using errcode = 'check_violation'; end if;
    select case r.kind
             when 'discount_pct' then round(v_subtotal * r.value_bps / 10000.0)::integer
             when 'discount_amount' then least(r.value_cents, v_subtotal)
             when 'free_product' then coalesce((select min(unit_price_cents) from order_items where order_id = v_order_id and product_id = r.product_id), 0)
             else 0 end
      into v_reward_disc from rewards r where r.id = v_reward.reward_id;
    v_discount := v_discount + coalesce(v_reward_disc, 0);
  end if;

  v_discount := least(v_discount, v_subtotal);
  if not bs.prices_include_tax and bs.tax_rate_bps > 0 then
    v_tax := round((v_subtotal - v_discount) * bs.tax_rate_bps / 10000.0);
  end if;
  v_total := v_subtotal - v_discount + v_fee + v_tax + v_tip;

  update orders set subtotal_cents = v_subtotal, discount_cents = v_discount, tax_cents = v_tax, total_cents = v_total,
         coupon_id = v_coupon_id, coupon_code = v_coupon_code, reward_redemption_id = v_reward.id
   where id = v_order_id;

  insert into order_status_history(order_id, from_status, to_status, staff_id) values (v_order_id, null, 'new', current_staff_id());
  perform emit_event('ORDER_CREATED', 'order', v_order_id::text, jsonb_build_object('channel', v_channel, 'total_cents', v_total, 'customer_id', v_customer_id));
  return v_order_id;
end $$;

-- ── Transiciones de estado ──────────────────────────────────────────────────
create or replace function order_transition_allowed(p_from order_status, p_to order_status) returns boolean
language sql immutable as $$
  select case p_from
    when 'new' then p_to in ('confirmed','payment_pending','paid','cancelled')
    when 'confirmed' then p_to in ('payment_pending','paid','in_production','ready','cancelled')
    when 'payment_pending' then p_to in ('paid','confirmed','cancelled')
    when 'paid' then p_to in ('in_production','ready','ready_for_pickup','out_for_delivery','completed','cancelled','refunded')
    when 'in_production' then p_to in ('ready','ready_for_pickup','out_for_delivery','cancelled')
    when 'ready' then p_to in ('ready_for_pickup','out_for_delivery','delivered','completed')
    when 'ready_for_pickup' then p_to in ('delivered','completed','out_for_delivery')
    when 'out_for_delivery' then p_to in ('delivered','ready')
    when 'delivered' then p_to in ('completed','refunded')
    when 'completed' then p_to in ('refunded')
    else false end
$$;

create or replace function change_order_status(p_order_id uuid, p_to order_status, p_note text default null)
returns void language plpgsql as $$
declare
  o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception 'Pedido no existe'; end if;
  if o.status = p_to then return; end if;
  if not order_transition_allowed(o.status, p_to) then
    raise exception 'Transición no permitida: % → %', o.status, p_to using errcode = 'check_violation';
  end if;
  if p_to = 'cancelled' and exists (select 1 from sales where order_id = p_order_id and voided_at is null) then
    raise exception 'El pedido ya tiene una venta registrada; usa anular venta o reembolso' using errcode = 'check_violation';
  end if;
  update orders set status = p_to,
         confirmed_at = case when p_to = 'confirmed' then now() else confirmed_at end,
         completed_at = case when p_to in ('completed','delivered') then now() else completed_at end,
         cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
         cancel_reason = case when p_to = 'cancelled' then p_note else cancel_reason end
   where id = p_order_id;
  insert into order_status_history(order_id, from_status, to_status, note, staff_id) values (p_order_id, o.status, p_to, p_note, current_staff_id());
  perform emit_event(case p_to when 'confirmed' then 'ORDER_CONFIRMED' when 'cancelled' then 'ORDER_CANCELLED' else 'ORDER_STATUS_CHANGED' end,
                     'order', p_order_id::text, jsonb_build_object('from', o.status, 'to', p_to));
  if p_to = 'cancelled' and o.coupon_id is not null then
    -- liberar uso del cupón si nunca se concretó la venta
    delete from coupon_redemptions where order_id = p_order_id;
  end if;
  if p_to = 'cancelled' and o.reward_redemption_id is not null then
    update reward_redemptions set status = 'issued', order_id = null, applied_at = null where id = o.reward_redemption_id and status = 'applied';
  end if;
end $$;

-- ── Finalizar venta (idempotente) ───────────────────────────────────────────
create or replace function finalize_sale(p_order_id uuid, p_register_session_id uuid default null) returns uuid
language plpgsql as $$
declare
  o orders%rowtype;
  v_sale_id uuid;
  v_cost integer;
  v_items numeric;
  v_points integer;
  bs business_settings%rowtype;
  it record;
  v_on_hand numeric;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception 'Pedido no existe'; end if;
  select id into v_sale_id from sales where order_id = p_order_id;
  if v_sale_id is not null then return v_sale_id; end if;
  if o.status in ('cancelled','refunded') then raise exception 'Pedido cancelado' using errcode = 'check_violation'; end if;
  select * into bs from business_settings where id = 1;

  -- Costos snapshot (si faltaban)
  update order_items set unit_cost_cents = product_cost_cents(product_id) where order_id = p_order_id and unit_cost_cents is null and product_id is not null;
  select sum(round(coalesce(unit_cost_cents, 0) * qty))::integer, sum(qty)
    into v_cost, v_items from order_items where order_id = p_order_id;

  insert into sales(order_id, channel, customer_id, register_session_id, staff_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, cost_cents, items_count)
  values (p_order_id, o.channel, o.customer_id, p_register_session_id, current_staff_id(), o.subtotal_cents, o.discount_cents, o.tax_cents, o.tip_cents, o.total_cents,
          case when (select bool_and(unit_cost_cents is not null) from order_items where order_id = p_order_id) then v_cost else null end, coalesce(v_items, 0))
  returning id into v_sale_id;

  -- Inventario: descuenta productos con control de stock
  for it in select oi.product_id, oi.qty, p.track_stock, p.name from order_items oi join products p on p.id = oi.product_id where oi.order_id = p_order_id loop
    if it.track_stock then
      select coalesce(on_hand, 0) into v_on_hand from inventory_levels where product_id = it.product_id;
      if not bs.allow_negative_stock and coalesce(v_on_hand, 0) < it.qty then
        raise exception 'Stock insuficiente para "%": hay %, se piden %', it.name, coalesce(v_on_hand,0), it.qty using errcode = 'check_violation';
      end if;
      insert into inventory_movements(product_id, type, qty, ref_type, ref_id, staff_id)
      values (it.product_id, 'SALE', -it.qty, 'sale', v_sale_id::text, current_staff_id());
      perform emit_event('PRODUCT_SOLD', 'product', it.product_id::text, jsonb_build_object('qty', it.qty, 'sale_id', v_sale_id, 'order_id', p_order_id));
      if coalesce(v_on_hand, 0) - it.qty <= bs.low_stock_threshold then
        insert into notifications(kind, severity, title, body, entity, entity_id)
        select case when coalesce(v_on_hand,0) - it.qty <= 0 then 'out_of_stock' else 'low_stock' end,
               'warning', case when coalesce(v_on_hand,0) - it.qty <= 0 then 'Producto agotado' else 'Stock bajo' end,
               it.name || ': quedan ' || (coalesce(v_on_hand,0) - it.qty)::text, 'product', it.product_id::text
        where not exists (select 1 from notifications n where n.entity = 'product' and n.entity_id = it.product_id::text and n.read_at is null and n.kind in ('low_stock','out_of_stock'));
      end if;
    end if;
  end loop;

  -- Cupón: registrar uso
  if o.coupon_id is not null then
    insert into coupon_redemptions(coupon_id, customer_id, order_id, discount_cents) values (o.coupon_id, o.customer_id, p_order_id, o.discount_cents);
    update coupons set uses_count = uses_count + 1 where id = o.coupon_id;
  end if;
  -- Recompensa: marcar aplicada
  if o.reward_redemption_id is not null then
    update reward_redemptions set status = 'applied', applied_at = now(), order_id = p_order_id where id = o.reward_redemption_id;
    perform emit_event('LOYALTY_POINTS_REDEEMED', 'customer', o.customer_id::text, jsonb_build_object('redemption_id', o.reward_redemption_id, 'order_id', p_order_id));
  end if;

  -- Cliente: estadísticas + puntos + nivel
  if o.customer_id is not null then
    update customers set total_orders = total_orders + 1, total_spent_cents = total_spent_cents + o.total_cents,
           first_purchase_at = coalesce(first_purchase_at, now()), last_purchase_at = now()
     where id = o.customer_id;
    v_points := loyalty_points_for(o.customer_id, o.total_cents, p_order_id);
    if v_points > 0 then
      perform loyalty_post(o.customer_id, 'earn', v_points, v_sale_id, null, 'Compra ' || o.folio);
      perform emit_event('LOYALTY_POINTS_EARNED', 'customer', o.customer_id::text, jsonb_build_object('points', v_points, 'sale_id', v_sale_id));
    end if;
    perform recompute_customer_tier(o.customer_id);
    -- Hitos
    insert into customer_events(customer_id, kind, payload)
    select o.customer_id, 'milestone_' || c.total_orders, jsonb_build_object('orders', c.total_orders)
    from customers c where c.id = o.customer_id and c.total_orders in (10, 25, 50, 100)
    on conflict do nothing;
    -- Regreso tras inactividad (>45 días)
    insert into customer_events(customer_id, kind, payload)
    select o.customer_id, 'returned', jsonb_build_object('days', extract(day from now() - lt.prev)::int)
    from (select max(sold_at) as prev from sales where customer_id = o.customer_id and id <> v_sale_id) lt
    where lt.prev is not null and lt.prev < now() - interval '45 days'
    on conflict do nothing;
  end if;

  -- Estado del pedido
  update orders set paid_at = coalesce(paid_at, now()), payment_status = 'paid' where id = p_order_id;
  if o.channel = 'pos' then
    if order_transition_allowed(o.status, 'paid') then perform change_order_status(p_order_id, 'paid'); end if;
    perform change_order_status(p_order_id, 'completed');
  else
    if order_transition_allowed(o.status, 'paid') then perform change_order_status(p_order_id, 'paid'); end if;
  end if;
  perform emit_event('ORDER_PAID', 'order', p_order_id::text, jsonb_build_object('sale_id', v_sale_id, 'total_cents', o.total_cents));
  insert into notifications(kind, severity, title, body, entity, entity_id)
  select 'new_order', 'info', 'Nuevo pedido pagado', o.folio || ' · $' || to_char(o.total_cents / 100.0, 'FM999999990.00'), 'order', p_order_id::text
  where o.channel <> 'pos';
  return v_sale_id;
end $$;

-- ── Registrar pago (idempotente) ────────────────────────────────────────────
-- payload: {order_id, provider, method, amount_cents, status?, tendered_cents?, external_id?, external_status?, reference?,
--           idempotency_key?, register_session_id?, metadata?}
create or replace function record_payment(p jsonb) returns jsonb
language plpgsql as $$
declare
  o orders%rowtype;
  v_payment_id uuid;
  v_status payment_status := coalesce((p->>'status')::payment_status, 'paid');
  v_amount integer := jsonb_int(p, 'amount_cents');
  v_tendered integer := jsonb_int(p, 'tendered_cents');
  v_change integer := 0;
  v_paid integer;
  v_sale_id uuid;
  v_idem text := nullif(p->>'idempotency_key', '');
  v_ext text := nullif(p->>'external_id', '');
  v_provider payment_provider := (p->>'provider')::payment_provider;
begin
  -- Idempotencia
  if v_idem is not null then
    select id into v_payment_id from payments where idempotency_key = v_idem;
  end if;
  if v_payment_id is null and v_ext is not null then
    select id into v_payment_id from payments where provider = v_provider and external_id = v_ext;
  end if;
  if v_payment_id is not null then
    select s.id into v_sale_id from sales s join payments pm on pm.order_id = s.order_id where pm.id = v_payment_id;
    return jsonb_build_object('payment_id', v_payment_id, 'sale_id', v_sale_id, 'duplicate', true);
  end if;

  select * into o from orders where id = jsonb_uuid(p, 'order_id') for update;
  if o.id is null then raise exception 'Pedido no existe'; end if;
  if o.status in ('cancelled','refunded') then raise exception 'Pedido cancelado' using errcode = 'check_violation'; end if;
  if v_amount is null or v_amount <= 0 then raise exception 'Monto inválido' using errcode = 'check_violation'; end if;
  if v_status = 'paid' and o.paid_cents + v_amount > o.total_cents then
    raise exception 'El pago excede el total del pedido (pagado %, total %, nuevo %)', o.paid_cents, o.total_cents, v_amount using errcode = 'check_violation';
  end if;
  if (p->>'method') = 'cash' and v_tendered is not null then
    if v_tendered < v_amount then raise exception 'Efectivo recibido menor al monto' using errcode = 'check_violation'; end if;
    v_change := v_tendered - v_amount;
  end if;

  insert into payments(order_id, provider, method, status, amount_cents, tendered_cents, change_cents, external_id, external_status, reference,
                       idempotency_key, metadata, received_by, register_session_id, confirmed_at, failed_at)
  values (o.id, v_provider, (p->>'method')::payment_method, v_status, v_amount, v_tendered, v_change, v_ext, p->>'external_status', p->>'reference',
          v_idem, coalesce(p->'metadata', '{}'::jsonb), current_staff_id(), jsonb_uuid(p, 'register_session_id'),
          case when v_status = 'paid' then now() end, case when v_status = 'failed' then now() end)
  returning id into v_payment_id;

  if v_status = 'paid' then
    v_paid := o.paid_cents + v_amount;
    update orders set paid_cents = v_paid, payment_status = (case when v_paid >= total_cents then 'paid' else 'partial' end)::payment_status where id = o.id;
    perform emit_event('PAYMENT_RECEIVED', 'order', o.id::text, jsonb_build_object('payment_id', v_payment_id, 'amount_cents', v_amount, 'method', p->>'method'));
    if v_paid >= o.total_cents then
      v_sale_id := finalize_sale(o.id, jsonb_uuid(p, 'register_session_id'));
    end if;
  elsif v_status = 'failed' then
    perform emit_event('PAYMENT_FAILED', 'order', o.id::text, jsonb_build_object('payment_id', v_payment_id, 'amount_cents', v_amount));
    insert into notifications(kind, severity, title, body, entity, entity_id)
    values ('payment_failed', 'error', 'Pago rechazado', o.folio, 'order', o.id::text);
  elsif v_status = 'pending' and o.status = 'new' then
    perform change_order_status(o.id, 'payment_pending');
  end if;

  return jsonb_build_object('payment_id', v_payment_id, 'sale_id', v_sale_id, 'change_cents', v_change, 'duplicate', false);
end $$;

-- ── Venta rápida en POS: pedido + pago(s) + venta en una transacción ─────────
-- payload: create_order payload + {payments:[{provider, method, amount_cents, tendered_cents?, reference?, external_id?, status?}], register_session_id?}
create or replace function pos_checkout(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_order_id uuid;
  v_pay jsonb;
  v_res jsonb;
  v_change integer := 0;
  v_sale_id uuid;
  o orders%rowtype;
  v_points integer := 0;
  v_session uuid := jsonb_uuid(p, 'register_session_id');
  v_idem text := nullif(p->>'idempotency_key', '');
begin
  if v_idem is not null then
    select id into v_order_id from orders where idempotency_key = v_idem;
    if v_order_id is not null then
      select * into o from orders where id = v_order_id;
      select id into v_sale_id from sales where order_id = v_order_id;
      return jsonb_build_object('order_id', v_order_id, 'sale_id', v_sale_id, 'folio', o.folio, 'total_cents', o.total_cents, 'duplicate', true);
    end if;
  end if;
  if v_session is not null and not exists (select 1 from register_sessions where id = v_session and status = 'open') then
    raise exception 'La caja no está abierta' using errcode = 'check_violation';
  end if;
  v_order_id := create_order(p || jsonb_build_object('channel', coalesce(p->>'channel', 'pos')));
  select * into o from orders where id = v_order_id;

  if jsonb_typeof(p->'payments') = 'array' then
    for v_pay in select * from jsonb_array_elements(p->'payments') loop
      v_res := record_payment(v_pay || jsonb_build_object('order_id', v_order_id, 'register_session_id', v_session,
                                'idempotency_key', case when v_idem is not null then v_idem || ':' || coalesce(v_pay->>'method','x') || ':' || coalesce(v_pay->>'amount_cents','0') end));
      v_change := v_change + coalesce((v_res->>'change_cents')::integer, 0);
      if v_res->>'sale_id' is not null then v_sale_id := (v_res->>'sale_id')::uuid; end if;
    end loop;
  end if;
  -- Pedido de total $0 (100% recompensa/cupón) se concreta sin pago
  if v_sale_id is null and o.total_cents = 0 then v_sale_id := finalize_sale(v_order_id, v_session); end if;

  select * into o from orders where id = v_order_id;
  if o.customer_id is not null and v_sale_id is not null then
    select coalesce(sum(points), 0) into v_points from loyalty_transactions where sale_id = v_sale_id and kind = 'earn';
  end if;
  return jsonb_build_object('order_id', v_order_id, 'sale_id', v_sale_id, 'folio', o.folio, 'total_cents', o.total_cents,
                            'paid_cents', o.paid_cents, 'change_cents', v_change, 'points_earned', v_points, 'status', o.status, 'duplicate', false);
end $$;

-- ── Anular venta ────────────────────────────────────────────────────────────
create or replace function void_sale(p_sale_id uuid, p_reason text) returns void
language plpgsql as $$
declare
  s sales%rowtype;
  it record;
  v_points integer;
begin
  select * into s from sales where id = p_sale_id for update;
  if s.id is null then raise exception 'Venta no existe'; end if;
  if s.voided_at is not null then return; end if;
  update sales set voided_at = now(), void_reason = p_reason where id = p_sale_id;
  -- Inventario: revertir
  for it in select product_id, qty from inventory_movements where ref_type = 'sale' and ref_id = p_sale_id::text and type = 'SALE' loop
    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, staff_id)
    values (it.product_id, 'VOID', -it.qty, 'sale', p_sale_id::text, p_reason, current_staff_id());
  end loop;
  -- Puntos: revertir lo ganado
  if s.customer_id is not null then
    select coalesce(sum(points), 0) into v_points from loyalty_transactions where sale_id = p_sale_id and kind in ('earn','bonus');
    if v_points > 0 then
      perform loyalty_post(s.customer_id, 'reversal', -least(v_points, (select points_balance from customers where id = s.customer_id)), p_sale_id, null, 'Anulación ' || p_reason);
    end if;
    update customers set total_orders = greatest(total_orders - 1, 0), total_spent_cents = greatest(total_spent_cents - s.total_cents, 0) where id = s.customer_id;
    perform recompute_customer_tier(s.customer_id);
  end if;
  -- Cupón / recompensa
  delete from coupon_redemptions where order_id = s.order_id;
  update coupons set uses_count = greatest(uses_count - 1, 0) where id = (select coupon_id from orders where id = s.order_id);
  update reward_redemptions set status = 'issued', applied_at = null, order_id = null where order_id = s.order_id and status = 'applied';
  -- Pagos y pedido
  update payments set status = 'cancelled' where order_id = s.order_id and status = 'paid';
  update orders set status = 'cancelled', payment_status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, paid_cents = 0 where id = s.order_id;
  insert into order_status_history(order_id, from_status, to_status, note, staff_id)
  select s.order_id, status, 'cancelled', 'Venta anulada: ' || p_reason, current_staff_id() from orders where id = s.order_id;
  perform emit_event('SALE_VOIDED', 'sale', p_sale_id::text, jsonb_build_object('reason', p_reason, 'order_id', s.order_id));
end $$;

-- ── Reembolso (financiero; la devolución física es aparte) ──────────────────
create or replace function record_refund(p jsonb) returns uuid
language plpgsql as $$
declare
  pm payments%rowtype;
  o orders%rowtype;
  s sales%rowtype;
  v_refund_id uuid;
  v_amount integer := jsonb_int(p, 'amount_cents');
  v_idem text := nullif(p->>'idempotency_key','');
  v_total_refunded integer;
  v_points integer;
  v_pts_reverse integer;
begin
  if v_idem is not null then
    select id into v_refund_id from refunds where idempotency_key = v_idem;
    if v_refund_id is not null then return v_refund_id; end if;
  end if;
  select * into pm from payments where id = jsonb_uuid(p, 'payment_id') for update;
  if pm.id is null then raise exception 'Pago no existe'; end if;
  if pm.status not in ('paid','partially_refunded') then raise exception 'El pago no es reembolsable (estado %)', pm.status using errcode = 'check_violation'; end if;
  select * into o from orders where id = pm.order_id for update;
  select coalesce(sum(amount_cents), 0) into v_total_refunded from refunds where payment_id = pm.id and status <> 'failed';
  if v_amount is null or v_amount <= 0 or v_total_refunded + v_amount > pm.amount_cents then
    raise exception 'Monto de reembolso inválido (pagado %, ya reembolsado %)', pm.amount_cents, v_total_refunded using errcode = 'check_violation';
  end if;
  insert into refunds(payment_id, order_id, amount_cents, reason, status, external_id, idempotency_key, staff_id, completed_at)
  values (pm.id, o.id, v_amount, p->>'reason', coalesce(p->>'status', 'completed'), nullif(p->>'external_id',''), v_idem, current_staff_id(),
          case when coalesce(p->>'status','completed') = 'completed' then now() end)
  returning id into v_refund_id;
  v_total_refunded := v_total_refunded + v_amount;
  update payments set status = (case when v_total_refunded >= amount_cents then 'refunded' else 'partially_refunded' end)::payment_status where id = pm.id;
  update orders set refunded_cents = refunded_cents + v_amount,
         payment_status = (case when refunded_cents + v_amount >= paid_cents then 'refunded' else 'partially_refunded' end)::payment_status
   where id = o.id;
  -- Puntos: revertir proporcionalmente
  select * into s from sales where order_id = o.id;
  if s.id is not null and s.customer_id is not null and o.total_cents > 0 then
    select coalesce(sum(points), 0) into v_points from loyalty_transactions where sale_id = s.id and kind = 'earn';
    v_pts_reverse := floor(v_points * v_amount::numeric / o.total_cents);
    v_pts_reverse := least(v_pts_reverse, (select points_balance from customers where id = s.customer_id));
    if v_pts_reverse > 0 then perform loyalty_post(s.customer_id, 'reversal', -v_pts_reverse, s.id, null, 'Reembolso ' || o.folio); end if;
    update customers set total_spent_cents = greatest(total_spent_cents - v_amount, 0) where id = s.customer_id;
  end if;
  if o.refunded_cents + v_amount >= o.paid_cents and order_transition_allowed(o.status, 'refunded') then
    perform change_order_status(o.id, 'refunded', p->>'reason');
  end if;
  perform emit_event('PAYMENT_REFUNDED', 'order', o.id::text, jsonb_build_object('refund_id', v_refund_id, 'amount_cents', v_amount));
  return v_refund_id;
end $$;

-- Devolución física (opcionalmente regresa stock)
create or replace function record_return(p jsonb) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_product uuid := jsonb_uuid(p, 'product_id');
  v_qty numeric := (p->>'qty')::numeric;
begin
  insert into returns(order_id, order_item_id, product_id, qty, restock, reason, staff_id)
  values (jsonb_uuid(p, 'order_id'), jsonb_uuid(p, 'order_item_id'), v_product, v_qty, coalesce((p->>'restock')::boolean, false), p->>'reason', current_staff_id())
  returning id into v_id;
  if coalesce((p->>'restock')::boolean, false) and v_product is not null then
    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, staff_id)
    values (v_product, 'RETURN', v_qty, 'return', v_id::text, p->>'reason', current_staff_id());
  end if;
  return v_id;
end $$;

-- ── Producción ──────────────────────────────────────────────────────────────
create or replace function record_production(p_product_id uuid, p_qty numeric, p_notes text default null, p_consume_ingredients boolean default null, p_produced_at timestamptz default now())
returns uuid language plpgsql as $$
declare
  v_batch uuid;
  v_flag boolean;
  r recipes%rowtype;
  it record;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Cantidad inválida' using errcode = 'check_violation'; end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then raise exception 'Producto no existe'; end if;
  select enabled into v_flag from feature_flags where key = 'ingredient_consumption';
  insert into production_batches(product_id, qty, produced_at, staff_id, notes, cost_cents_snapshot)
  values (p_product_id, p_qty, coalesce(p_produced_at, now()), current_staff_id(), p_notes, product_cost_cents(p_product_id, coalesce(p_produced_at, now())))
  returning id into v_batch;
  insert into inventory_movements(product_id, type, qty, ref_type, ref_id, staff_id, occurred_at)
  values (p_product_id, 'PRODUCTION', p_qty, 'production_batch', v_batch::text, current_staff_id(), coalesce(p_produced_at, now()));
  if coalesce(p_consume_ingredients, v_flag, false) then
    select * into r from recipes where product_id = p_product_id;
    if r.id is not null then
      for it in select ingredient_id, qty from recipe_items where recipe_id = r.id loop
        insert into ingredient_movements(ingredient_id, type, qty, ref_type, ref_id, staff_id, occurred_at)
        values (it.ingredient_id, 'CONSUMPTION', -(it.qty * p_qty / r.yield_qty), 'production_batch', v_batch::text, current_staff_id(), coalesce(p_produced_at, now()));
      end loop;
      update production_batches set ingredients_consumed = true where id = v_batch;
      insert into notifications(kind, severity, title, body, entity, entity_id)
      select 'ingredient_low', 'warning', 'Insumo crítico', i.name || ': quedan ' || i.stock_qty || ' ' || i.base_unit, 'ingredient', i.id::text
      from ingredients i where i.id in (select ingredient_id from recipe_items where recipe_id = r.id) and i.stock_qty <= i.min_stock_qty and i.min_stock_qty > 0
        and not exists (select 1 from notifications n where n.entity = 'ingredient' and n.entity_id = i.id::text and n.read_at is null);
    end if;
  end if;
  -- Cierra alertas de stock bajo si ya se repuso
  update notifications set read_at = now() where entity = 'product' and entity_id = p_product_id::text and read_at is null and kind in ('low_stock','out_of_stock')
    and (select on_hand from inventory_levels where product_id = p_product_id) > (select low_stock_threshold from business_settings where id = 1);
  perform emit_event('PRODUCT_PRODUCED', 'product', p_product_id::text, jsonb_build_object('qty', p_qty, 'batch_id', v_batch));
  return v_batch;
end $$;

-- ── Merma ───────────────────────────────────────────────────────────────────
create or replace function record_waste(p_product_id uuid, p_qty numeric, p_reason text, p_note text default null, p_occurred_at timestamptz default now())
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Cantidad inválida' using errcode = 'check_violation'; end if;
  insert into waste_records(product_id, qty, reason, note, staff_id, occurred_at, cost_cents_snapshot)
  values (p_product_id, p_qty, p_reason, p_note, current_staff_id(), coalesce(p_occurred_at, now()), product_cost_cents(p_product_id, coalesce(p_occurred_at, now())))
  returning id into v_id;
  insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, note, staff_id, occurred_at)
  values (p_product_id, (case when p_reason in ('gift','courtesy') then 'GIFT' when p_reason = 'internal_use' then 'INTERNAL_USE' else 'WASTE' end)::movement_type,
          -p_qty, 'waste_record', v_id::text, p_reason, p_note, current_staff_id(), coalesce(p_occurred_at, now()));
  perform emit_event('WASTE_RECORDED', 'product', p_product_id::text, jsonb_build_object('qty', p_qty, 'reason', p_reason, 'waste_id', v_id));
  return v_id;
end $$;

-- ── Conteo físico → correcciones ────────────────────────────────────────────
create or replace function apply_stock_count(p_stock_count_id uuid) returns integer
language plpgsql as $$
declare
  sc stock_counts%rowtype;
  it record;
  n integer := 0;
begin
  select * into sc from stock_counts where id = p_stock_count_id for update;
  if sc.id is null then raise exception 'Conteo no existe'; end if;
  if sc.status <> 'open' then return 0; end if;
  for it in select * from stock_count_items where stock_count_id = p_stock_count_id and counted_qty <> expected_qty loop
    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, note, staff_id)
    values (it.product_id, 'CORRECTION', it.counted_qty - it.expected_qty, 'stock_count', p_stock_count_id::text, 'difference', it.note, current_staff_id());
    n := n + 1;
  end loop;
  update stock_counts set status = 'applied', closed_at = now() where id = p_stock_count_id;
  perform emit_event('STOCK_COUNT_APPLIED', 'stock_count', p_stock_count_id::text, jsonb_build_object('corrections', n));
  return n;
end $$;

-- ── Caja ────────────────────────────────────────────────────────────────────
create or replace function open_register(p_opening_cash_cents integer, p_notes text default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  if exists (select 1 from register_sessions where status = 'open') then
    raise exception 'Ya hay una caja abierta' using errcode = 'unique_violation';
  end if;
  insert into register_sessions(opened_by, opening_cash_cents, notes) values (current_staff_id(), coalesce(p_opening_cash_cents, 0), p_notes) returning id into v_id;
  perform emit_event('REGISTER_OPENED', 'register_session', v_id::text, jsonb_build_object('opening_cash_cents', p_opening_cash_cents));
  return v_id;
end $$;

create or replace function register_expected_cash(p_session_id uuid) returns integer
language sql stable as $$
  select rs.opening_cash_cents
       + coalesce((select sum(amount_cents) from payments where register_session_id = rs.id and method = 'cash' and status in ('paid','partially_refunded','refunded')), 0)
       - coalesce((select sum(r.amount_cents) from refunds r join payments p on p.id = r.payment_id where p.register_session_id = rs.id and p.method = 'cash' and r.status = 'completed'), 0)
       - coalesce((select sum(amount_cents) from payments where register_session_id = rs.id and method = 'cash' and status = 'cancelled'), 0) * 0
  from register_sessions rs where rs.id = p_session_id
$$;

create or replace function close_register(p_session_id uuid, p_counted_cash_cents integer, p_notes text default null) returns jsonb
language plpgsql as $$
declare
  rs register_sessions%rowtype;
  v_expected integer;
  v_card integer; v_transfer integer; v_mp integer; v_other integer;
begin
  select * into rs from register_sessions where id = p_session_id for update;
  if rs.id is null then raise exception 'Sesión de caja no existe'; end if;
  if rs.status = 'closed' then return jsonb_build_object('already_closed', true); end if;
  v_expected := register_expected_cash(p_session_id);
  select coalesce(sum(amount_cents) filter (where method = 'card_terminal'), 0),
         coalesce(sum(amount_cents) filter (where method = 'transfer'), 0),
         coalesce(sum(amount_cents) filter (where method = 'mercadopago'), 0),
         coalesce(sum(amount_cents) filter (where method not in ('cash','card_terminal','transfer','mercadopago')), 0)
    into v_card, v_transfer, v_mp, v_other
  from payments where register_session_id = p_session_id and status in ('paid','partially_refunded','refunded');
  update register_sessions set status = 'closed', closed_at = now(), closed_by = current_staff_id(),
         expected_cash_cents = v_expected, counted_cash_cents = p_counted_cash_cents, difference_cents = p_counted_cash_cents - v_expected,
         card_cents = v_card, transfer_cents = v_transfer, mercadopago_cents = v_mp, other_cents = v_other,
         notes = coalesce(p_notes, notes)
   where id = p_session_id;
  perform emit_event('REGISTER_CLOSED', 'register_session', p_session_id::text, jsonb_build_object('expected', v_expected, 'counted', p_counted_cash_cents));
  if abs(p_counted_cash_cents - v_expected) > 0 then
    insert into notifications(kind, severity, title, body, entity, entity_id)
    values ('register_difference', 'warning', 'Diferencia en cierre de caja', 'Esperado $' || to_char(v_expected/100.0,'FM999999990.00') || ' · Contado $' || to_char(p_counted_cash_cents/100.0,'FM999999990.00'), 'register_session', p_session_id::text);
  end if;
  return jsonb_build_object('expected_cash_cents', v_expected, 'counted_cash_cents', p_counted_cash_cents, 'difference_cents', p_counted_cash_cents - v_expected,
                            'card_cents', v_card, 'transfer_cents', v_transfer, 'mercadopago_cents', v_mp, 'other_cents', v_other);
end $$;

-- ── Clientes: registro (QR / web / POS) con deduplicación ───────────────────
-- payload: {full_name, phone?, email?, birthday?, source?, marketing_consent?, notes?}
create or replace function register_customer(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid;
  v_phone citext := nullif(regexp_replace(coalesce(p->>'phone',''), '[^0-9+]', '', 'g'), '');
  v_email citext := nullif(lower(btrim(coalesce(p->>'email',''))), '');
  v_existing customers%rowtype;
  prog loyalty_program%rowtype;
begin
  if nullif(btrim(coalesce(p->>'full_name','')), '') is null then raise exception 'El nombre es obligatorio' using errcode = 'check_violation'; end if;
  if v_phone is null and v_email is null then raise exception 'Se requiere teléfono o email' using errcode = 'check_violation'; end if;
  select * into v_existing from customers c where c.deleted_at is null and c.merged_into_id is null
    and ((v_phone is not null and c.phone = v_phone) or (v_email is not null and c.email = v_email)) limit 1;
  if v_existing.id is not null then
    update customers set
      email = coalesce(email, v_email), phone = coalesce(phone, v_phone),
      birthday = coalesce(birthday, nullif(p->>'birthday','')::date),
      marketing_consent = marketing_consent or coalesce((p->>'marketing_consent')::boolean, false)
    where id = v_existing.id;
    return jsonb_build_object('customer_id', v_existing.id, 'public_code', v_existing.public_code, 'qr_token', v_existing.qr_token, 'created', false);
  end if;
  insert into customers(full_name, phone, email, birthday, source, marketing_consent, notes)
  values (btrim(p->>'full_name'), v_phone, v_email, nullif(p->>'birthday','')::date, coalesce(p->>'source','pos'), coalesce((p->>'marketing_consent')::boolean, false), p->>'notes')
  returning id into v_id;
  select * into prog from loyalty_program where id = 1;
  if prog.is_active and prog.signup_bonus_points > 0 then
    perform loyalty_post(v_id, 'bonus', prog.signup_bonus_points, null, null, 'Bono de bienvenida');
  end if;
  perform recompute_customer_tier(v_id);
  perform emit_event('CUSTOMER_REGISTERED', 'customer', v_id::text, jsonb_build_object('source', p->>'source'));
  return (select jsonb_build_object('customer_id', id, 'public_code', public_code, 'qr_token', qr_token, 'created', true) from customers where id = v_id);
end $$;

-- ── Canje de recompensa (emite un cupón personal) ───────────────────────────
create or replace function redeem_reward(p_customer_id uuid, p_reward_id uuid) returns jsonb
language plpgsql as $$
declare
  r rewards%rowtype;
  c customers%rowtype;
  v_id uuid;
begin
  select * into r from rewards where id = p_reward_id;
  if r.id is null or not r.is_active then raise exception 'Recompensa no disponible' using errcode = 'check_violation'; end if;
  if (r.starts_at is not null and r.starts_at > now()) or (r.ends_at is not null and r.ends_at < now()) then raise exception 'Recompensa fuera de vigencia' using errcode = 'check_violation'; end if;
  select * into c from customers where id = p_customer_id for update;
  if c.id is null then raise exception 'Cliente no existe'; end if;
  if r.min_tier_key is not null and coalesce((select rank from loyalty_tiers where key = c.tier_key), 0) < (select rank from loyalty_tiers where key = r.min_tier_key) then
    raise exception 'Nivel insuficiente para esta recompensa' using errcode = 'check_violation';
  end if;
  insert into reward_redemptions(reward_id, customer_id, points_spent, staff_id, expires_at)
  values (r.id, c.id, r.points_cost, current_staff_id(), now() + interval '90 days') returning id into v_id;
  perform loyalty_post(c.id, 'redeem', -r.points_cost, null, v_id, 'Canje: ' || r.name);
  perform emit_event('REWARD_REDEEMED', 'customer', c.id::text, jsonb_build_object('reward_id', r.id, 'redemption_id', v_id, 'points', r.points_cost));
  return (select jsonb_build_object('redemption_id', id, 'code', code, 'expires_at', expires_at) from reward_redemptions where id = v_id);
end $$;

-- ── Mercado Pago: aplicar resultado de pago (idempotente por external_id) ───
-- p: {order_id, external_id, mp_status, amount_cents, method?, raw?}
create or replace function apply_mercadopago_payment(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_status payment_status;
  v_mp text := lower(coalesce(p->>'mp_status', ''));
  v_existing payments%rowtype;
  o orders%rowtype;
  v_res jsonb;
begin
  v_status := case v_mp
    when 'approved' then 'paid'
    when 'authorized' then 'authorized'
    when 'pending' then 'pending'
    when 'in_process' then 'pending'
    when 'in_mediation' then 'pending'
    when 'rejected' then 'failed'
    when 'cancelled' then 'cancelled'
    when 'refunded' then 'refunded'
    when 'charged_back' then 'refunded'
    else 'pending' end;

  select * into v_existing from payments where provider = 'mercadopago' and external_id = p->>'external_id' for update;
  select * into o from orders where id = jsonb_uuid(p, 'order_id');
  if o.id is null then raise exception 'Pedido no existe'; end if;

  if v_existing.id is null then
    -- Primer aviso de este pago
    v_res := record_payment(jsonb_build_object('order_id', o.id, 'provider', 'mercadopago', 'method', coalesce(p->>'method', 'mercadopago'),
              'amount_cents', p->>'amount_cents', 'status', case when v_status in ('refunded') then 'paid' else v_status end,
              'external_id', p->>'external_id', 'external_status', v_mp, 'metadata', coalesce(p->'raw', '{}'::jsonb)));
    if v_status = 'refunded' then
      perform record_refund(jsonb_build_object('payment_id', v_res->>'payment_id', 'amount_cents', p->>'amount_cents', 'reason', 'Reembolso Mercado Pago', 'external_id', p->>'external_id', 'idempotency_key', 'mp-refund:' || (p->>'external_id')));
    end if;
    return v_res || jsonb_build_object('applied_status', v_status);
  end if;

  -- Ya existía: transición de estado del mismo pago
  if v_existing.status = v_status then
    return jsonb_build_object('payment_id', v_existing.id, 'duplicate', true, 'applied_status', v_status);
  end if;
  if v_existing.status in ('pending','authorized') and v_status = 'paid' then
    update payments set status = 'paid', external_status = v_mp, confirmed_at = now(), metadata = metadata || coalesce(p->'raw','{}'::jsonb) where id = v_existing.id;
    update orders set paid_cents = paid_cents + v_existing.amount_cents,
           payment_status = (case when paid_cents + v_existing.amount_cents >= total_cents then 'paid' else 'partial' end)::payment_status where id = o.id;
    perform emit_event('PAYMENT_RECEIVED', 'order', o.id::text, jsonb_build_object('payment_id', v_existing.id, 'amount_cents', v_existing.amount_cents, 'method', 'mercadopago'));
    select * into o from orders where id = o.id;
    if o.paid_cents >= o.total_cents then
      return jsonb_build_object('payment_id', v_existing.id, 'sale_id', finalize_sale(o.id), 'applied_status', v_status);
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'applied_status', v_status);
  end if;
  if v_existing.status in ('pending','authorized') and v_status in ('failed','cancelled') then
    update payments set status = v_status, external_status = v_mp, failed_at = now() where id = v_existing.id;
    perform emit_event('PAYMENT_FAILED', 'order', o.id::text, jsonb_build_object('payment_id', v_existing.id));
    return jsonb_build_object('payment_id', v_existing.id, 'applied_status', v_status);
  end if;
  if v_existing.status in ('paid','partially_refunded') and v_status = 'refunded' then
    perform record_refund(jsonb_build_object('payment_id', v_existing.id, 'amount_cents', v_existing.amount_cents - coalesce((select sum(amount_cents) from refunds where payment_id = v_existing.id and status <> 'failed'), 0),
                                             'reason', 'Reembolso Mercado Pago', 'external_id', p->>'external_id', 'idempotency_key', 'mp-refund:' || (p->>'external_id')));
    return jsonb_build_object('payment_id', v_existing.id, 'applied_status', v_status);
  end if;
  update payments set external_status = v_mp where id = v_existing.id;
  return jsonb_build_object('payment_id', v_existing.id, 'applied_status', v_existing.status, 'ignored_transition', v_status);
end $$;

-- ── Producción sugerida ─────────────────────────────────────────────────────
-- Pedidos comprometidos para una fecha + promedio de ventas de los últimos 4 mismos días de semana.
create or replace function suggested_production(p_date date) returns table (
  product_id uuid, product_name text, committed_qty numeric, avg_sold_qty numeric, on_hand numeric, suggested_qty numeric
) language sql stable as $$
  with tz as (select timezone as z from business_settings where id = 1),
  committed as (
    select oi.product_id, sum(oi.qty) as qty
    from orders o join order_items oi on oi.order_id = o.id, tz
    where (o.scheduled_for at time zone tz.z)::date = p_date
      and o.status not in ('cancelled','refunded','completed','delivered')
    group by oi.product_id
  ),
  hist as (
    select oi.product_id, sum(oi.qty) / 4.0 as qty
    from sales s join order_items oi on oi.order_id = s.order_id, tz
    where s.voided_at is null
      and extract(dow from s.sold_at at time zone tz.z) = extract(dow from p_date)
      and (s.sold_at at time zone tz.z)::date >= p_date - 28 and (s.sold_at at time zone tz.z)::date < p_date
    group by oi.product_id
  )
  select p.id, p.name, coalesce(c.qty, 0), round(coalesce(h.qty, 0), 1), coalesce(l.on_hand, 0),
         greatest(0, coalesce(c.qty,0) + round(coalesce(h.qty,0)) - greatest(coalesce(l.on_hand,0), 0))
  from products p
  left join committed c on c.product_id = p.id
  left join hist h on h.product_id = p.id
  left join inventory_levels l on l.product_id = p.id
  where p.deleted_at is null and p.is_active
  order by (coalesce(c.qty,0) + coalesce(h.qty,0)) desc, p.name
$$;

-- ── Conciliación de inventario por rango ────────────────────────────────────
create or replace function inventory_reconciliation(p_from timestamptz, p_to timestamptz) returns table (
  product_id uuid, product_name text, opening numeric, production numeric, sales numeric, waste numeric, corrections numeric, other numeric, closing numeric
) language sql stable as $$
  select p.id, p.name,
    coalesce(sum(m.qty) filter (where m.occurred_at < p_from), 0) as opening,
    coalesce(sum(m.qty) filter (where m.occurred_at >= p_from and m.occurred_at < p_to and m.type = 'PRODUCTION'), 0),
    coalesce(-sum(m.qty) filter (where m.occurred_at >= p_from and m.occurred_at < p_to and m.type = 'SALE'), 0),
    coalesce(-sum(m.qty) filter (where m.occurred_at >= p_from and m.occurred_at < p_to and m.type in ('WASTE','GIFT','INTERNAL_USE')), 0),
    coalesce(sum(m.qty) filter (where m.occurred_at >= p_from and m.occurred_at < p_to and m.type = 'CORRECTION'), 0),
    coalesce(sum(m.qty) filter (where m.occurred_at >= p_from and m.occurred_at < p_to and m.type in ('RETURN','TRANSFER','VOID','INITIAL')), 0),
    coalesce(sum(m.qty) filter (where m.occurred_at < p_to), 0) as closing
  from products p left join inventory_movements m on m.product_id = p.id
  where p.deleted_at is null and p.track_stock
  group by p.id, p.name
  order by p.name
$$;
