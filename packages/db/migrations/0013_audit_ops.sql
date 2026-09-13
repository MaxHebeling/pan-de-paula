-- 0013_audit_ops.sql — Correcciones de la auditoría de OPERACIÓN (POS, caja, pedidos, inventario).
-- Aditiva: solo `create or replace` de funciones definidas en 0008 y un índice parcial. No toca datos.
-- NOTA de orden: este archivo corre antes de 0020/0030 en una base nueva; por eso SOLO redefine funciones
-- de 0008_transactions.sql (ninguna migración posterior las vuelve a definir).
--
-- 1) pos_checkout: la idempotency_key de cada pago se derivaba de método+monto, así que un pago dividido con
--    dos partes idénticas (dos tarjetas de $50) trataba la segunda como duplicado: el pedido quedaba "partial"
--    y sin venta. Ahora incluye la posición del pago. Además, dos peticiones SIMULTÁNEAS con la misma clave
--    devolvían 23505 (409 en la API) en vez de la respuesta idempotente `duplicate: true`.
-- 2) finalize_sale: con allow_negative_stock=false dos ventas simultáneas de la última pieza pasaban ambas la
--    validación (lectura sin bloqueo). Ahora bloquea la fila de inventory_levels (en orden de producto, sin
--    deadlocks) antes de validar.
-- 3) void_sale: si la venta ya tenía un reembolso parcial, revertía TODOS los puntos ganados y el total completo
--    del gasto del cliente (doble reversión). Ahora revierte solo el neto pendiente.
-- 4) record_return: no validaba nada (renglón de otro pedido, cantidad acumulada mayor a la vendida, pedido sin
--    venta). Ahora valida en SQL (la app también valida, defensa en profundidad).
-- 5) stock_counts: dos conteos creados en paralelo quedaban ambos abiertos (la validación era un `exists`).
--    Índice único parcial, igual que register_sessions.

-- ── 1) pos_checkout ─────────────────────────────────────────────────────────
create or replace function pos_checkout(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_order_id uuid;
  v_pay record;
  v_res jsonb;
  v_change integer := 0;
  v_sale_id uuid;
  o orders%rowtype;
  v_points integer := 0;
  v_session uuid := jsonb_uuid(p, 'register_session_id');
  v_idem text := nullif(p->>'idempotency_key', '');
  v_constraint text;
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
  -- Dos peticiones simultáneas con la misma clave (doble clic antes de la respuesta): la segunda choca con
  -- orders.idempotency_key al confirmar la primera. En vez de 23505 devolvemos la venta ya registrada.
  begin
    v_order_id := create_order(p || jsonb_build_object('channel', coalesce(p->>'channel', 'pos')));
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_idem is null or v_constraint <> 'orders_idempotency_key_key' then raise; end if;
    select * into o from orders where idempotency_key = v_idem;
    select id into v_sale_id from sales where order_id = o.id;
    return jsonb_build_object('order_id', o.id, 'sale_id', v_sale_id, 'folio', o.folio, 'total_cents', o.total_cents, 'duplicate', true);
  end;
  select * into o from orders where id = v_order_id;

  if jsonb_typeof(p->'payments') = 'array' then
    for v_pay in select value, ordinality from jsonb_array_elements(p->'payments') with ordinality loop
      v_res := record_payment(v_pay.value || jsonb_build_object('order_id', v_order_id, 'register_session_id', v_session,
                                'idempotency_key', case when v_idem is not null
                                  then v_idem || ':' || v_pay.ordinality || ':' || coalesce(v_pay.value->>'method','x') || ':' || coalesce(v_pay.value->>'amount_cents','0') end));
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

-- ── 2) finalize_sale ────────────────────────────────────────────────────────
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

  -- Inventario: descuenta productos con control de stock.
  -- Se bloquea la fila de nivel por producto (en orden de product_id para evitar deadlocks) ANTES de validar:
  -- dos ventas simultáneas de la última pieza ya no pasan ambas cuando allow_negative_stock=false.
  for it in select oi.product_id, oi.qty, p.track_stock, p.name
            from order_items oi join products p on p.id = oi.product_id
            where oi.order_id = p_order_id
            order by oi.product_id, oi.sort_order loop
    if it.track_stock then
      insert into inventory_levels(product_id, on_hand) values (it.product_id, 0) on conflict (product_id) do nothing;
      select on_hand into v_on_hand from inventory_levels where product_id = it.product_id for update;
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

-- ── 3) void_sale ────────────────────────────────────────────────────────────
create or replace function void_sale(p_sale_id uuid, p_reason text) returns void
language plpgsql as $$
declare
  s sales%rowtype;
  o orders%rowtype;
  it record;
  v_points integer;
begin
  select * into s from sales where id = p_sale_id for update;
  if s.id is null then raise exception 'Venta no existe'; end if;
  if s.voided_at is not null then return; end if;
  select * into o from orders where id = s.order_id for update;
  update sales set voided_at = now(), void_reason = p_reason where id = p_sale_id;
  -- Inventario: revertir
  for it in select product_id, qty from inventory_movements where ref_type = 'sale' and ref_id = p_sale_id::text and type = 'SALE' loop
    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, staff_id)
    values (it.product_id, 'VOID', -it.qty, 'sale', p_sale_id::text, p_reason, current_staff_id());
  end loop;
  -- Puntos: revertir solo el NETO pendiente de esta venta (ganados − ya revertidos por reembolsos parciales)
  if s.customer_id is not null then
    select coalesce(sum(points), 0) into v_points from loyalty_transactions where sale_id = p_sale_id;
    if v_points > 0 then
      perform loyalty_post(s.customer_id, 'reversal', -least(v_points, (select points_balance from customers where id = s.customer_id)), p_sale_id, null, 'Anulación ' || p_reason);
    end if;
    -- Gasto: lo que aún no se había restado por reembolsos
    update customers set total_orders = greatest(total_orders - 1, 0),
           total_spent_cents = greatest(total_spent_cents - greatest(s.total_cents - coalesce(o.refunded_cents, 0), 0), 0)
     where id = s.customer_id;
    perform recompute_customer_tier(s.customer_id);
  end if;
  -- Cupón / recompensa
  delete from coupon_redemptions where order_id = s.order_id;
  update coupons set uses_count = greatest(uses_count - 1, 0) where id = o.coupon_id;
  update reward_redemptions set status = 'issued', applied_at = null, order_id = null where order_id = s.order_id and status = 'applied';
  -- Pagos y pedido
  update payments set status = 'cancelled' where order_id = s.order_id and status = 'paid';
  update orders set status = 'cancelled', payment_status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, paid_cents = 0 where id = s.order_id;
  insert into order_status_history(order_id, from_status, to_status, note, staff_id)
  values (s.order_id, o.status, 'cancelled', 'Venta anulada: ' || p_reason, current_staff_id());
  perform emit_event('SALE_VOIDED', 'sale', p_sale_id::text, jsonb_build_object('reason', p_reason, 'order_id', s.order_id));
end $$;

-- ── 4) record_return ────────────────────────────────────────────────────────
create or replace function record_return(p jsonb) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_order uuid := jsonb_uuid(p, 'order_id');
  v_item uuid := jsonb_uuid(p, 'order_item_id');
  v_product uuid := jsonb_uuid(p, 'product_id');
  v_qty numeric := (p->>'qty')::numeric;
  v_restock boolean := coalesce((p->>'restock')::boolean, false);
  oi order_items%rowtype;
  v_returned numeric;
begin
  if v_qty is null or v_qty <= 0 then raise exception 'Cantidad inválida' using errcode = 'check_violation'; end if;
  if v_order is null or not exists (select 1 from orders where id = v_order) then raise exception 'Pedido no existe'; end if;
  if not exists (select 1 from sales where order_id = v_order and voided_at is null) then
    raise exception 'El pedido no tiene una venta registrada; no hay nada que devolver' using errcode = 'check_violation';
  end if;
  if v_item is not null then
    select * into oi from order_items where id = v_item for update;
    if oi.id is null or oi.order_id <> v_order then
      raise exception 'El producto no pertenece a este pedido' using errcode = 'check_violation';
    end if;
    if v_product is null then v_product := oi.product_id; end if;
    if v_product is distinct from oi.product_id then
      raise exception 'El producto no coincide con el renglón del pedido' using errcode = 'check_violation';
    end if;
    select coalesce(sum(qty), 0) into v_returned from returns where order_item_id = v_item;
    if v_returned + v_qty > oi.qty then
      raise exception 'Solo se vendieron % unidades (ya devueltas %)', oi.qty, v_returned using errcode = 'check_violation';
    end if;
  end if;
  insert into returns(order_id, order_item_id, product_id, qty, restock, reason, staff_id)
  values (v_order, v_item, v_product, v_qty, v_restock, p->>'reason', current_staff_id())
  returning id into v_id;
  if v_restock and v_product is not null and exists (select 1 from products where id = v_product and track_stock) then
    insert into inventory_movements(product_id, type, qty, ref_type, ref_id, reason, staff_id)
    values (v_product, 'RETURN', v_qty, 'return', v_id::text, p->>'reason', current_staff_id());
  end if;
  perform emit_event('RETURN_RECORDED', 'order', v_order::text, jsonb_build_object('return_id', v_id, 'qty', v_qty, 'restock', v_restock, 'product_id', v_product));
  return v_id;
end $$;

-- ── 5) Un solo conteo físico abierto (garantía a nivel de base, como register_sessions) ──
create unique index if not exists stock_counts_open_idx on stock_counts(status) where status = 'open';
