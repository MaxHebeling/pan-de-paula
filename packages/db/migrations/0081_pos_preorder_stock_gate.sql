-- 0081_pos_preorder_stock_gate.sql — finalize_sale confundía "agotado" con "todavía no horneado".
--
-- El guardia de existencias que 0013 añadió (y que arregló bien la carrera de dos ventas simultáneas
-- de la última pieza) solo miraba track_stock, allow_negative_stock y on_hand. No miraba
-- `allow_preorder`, que es justo lo que distingue un producto agotado de uno que se hornea por
-- encargo y por tanto está en cero casi todo el tiempo.
--
-- Consecuencia medida el 10/10/2026: los 21 productos activos tienen allow_preorder = true y 17
-- estaban en cero. Apagar allow_negative_stock —el interruptor de Configuración que promete
-- "el POS y la tienda bloquean productos agotados"— habría hecho que la caja rechazara 17 de 21
-- productos, incluidos el kouign-amann, las tres galletas y todas las docenas.
--
-- El sitio público ya decidía bien (apps/web/lib/availability.ts: `soldOut && !allowPreorder`).
-- Esta migración alinea la base con esa regla. La regla queda además en @pdp/domain
-- (`blockedByStock`) para que sitio, POS y base no vuelvan a divergir.
--
-- Solo cambia la condición del guardia y añade allow_preorder al bucle. Todo lo demás —el bloqueo
-- de fila con `for update` en orden de product_id, los movimientos, los eventos y las
-- notificaciones de stock bajo— queda idéntico a 0013.

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
  for it in select oi.product_id, oi.qty, p.track_stock, p.allow_preorder, p.name
            from order_items oi join products p on p.id = oi.product_id
            where oi.order_id = p_order_id
            order by oi.product_id, oi.sort_order loop
    if it.track_stock then
      insert into inventory_levels(product_id, on_hand) values (it.product_id, 0) on conflict (product_id) do nothing;
      select on_hand into v_on_hand from inventory_levels where product_id = it.product_id for update;
      -- `allow_preorder` es lo que separa "agotado" de "todavia no horneado": un producto que se
      -- hornea por encargo esta en cero casi siempre y debe poder venderse. Sin esta condicion,
      -- apagar allow_negative_stock bloqueaba 17 de los 21 productos activos.
      if not bs.allow_negative_stock and not it.allow_preorder and coalesce(v_on_hand, 0) < it.qty then
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
