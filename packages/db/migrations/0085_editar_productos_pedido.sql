-- 0085 — Editar los productos de un pedido que todavía no se ha cobrado: cambiar cantidades,
-- quitar renglones, agregar productos o cambiar uno por otro (quitar + agregar).
--
-- Es el paso que 0084 dejó fuera a propósito. Agregar en el mostrador solo puede SUBIR el total;
-- editar también puede bajarlo, y eso toca tres cosas que agregar no tocaba: un anticipo que puede
-- pasar a sobrar, un cupón que puede dejar de alcanzar y una recompensa de producto gratis cuyo
-- producto puede desaparecer del pedido.
--
-- Decisiones de negocio, tomadas con Max el 2026-11-04:
--
--  · ALCANCE: solo pedidos SIN venta viva (sin cobrar o con anticipo). Con la venta ya registrada
--    el total está congelado, el stock descontado, el cupón canjeado y los puntos otorgados; un
--    cambio ahí es una devolución o una venta nueva. Misma frontera que 0084.
--  · ANTICIPO: el total nuevo NO puede quedar por debajo de lo ya pagado. Si hace falta, primero se
--    registra el reembolso del excedente y después se edita. Si queda EXACTO, el pedido queda
--    pagado y se registra la venta, igual que cuando un pago alcanza el total (`record_payment`).
--  · QUIÉN: permiso nuevo `orders.edit_items`, solo para Super Admin, Dueño, CEO, Administradora y
--    Gerente. Caja y Ventas conservan `add_order_items` (agregar en el mostrador) tal como está.
--    El cliente nunca puede: el portal no tiene ninguna ruta de escritura sobre pedidos.
--
-- Descuento: NUNCA sube. Se toma el menor entre el descuento que ya tenía el pedido y lo que el
-- cupón/recompensa daría sobre el pedido nuevo. Con un 10 % sobre $500 ($50) y un pedido que baja a
-- $100, el descuento pasa a $10: congelarlo en $50 regalaría la mitad del pedido. Y al revés, si el
-- pedido sube, el descuento se queda donde estaba (mismo criterio que 0084).

-- ── Permiso ───────────────────────────────────────────────────────────────────
insert into permissions(key, module, description) values
  ('orders.edit_items', 'orders',
   'Editar los productos de un pedido sin cobrar: cambiar cantidades, quitar y cambiar productos')
on conflict (key) do nothing;

insert into role_permissions(role_key, permission_key)
select r.key, 'orders.edit_items' from roles r
 where r.key in ('super_admin', 'owner', 'ceo', 'admin', 'manager')
on conflict do nothing;

-- ── Bitácora + idempotencia ───────────────────────────────────────────────────
-- `order_items` no tiene disparador de auditoría (ver 0084): sin esta tabla constaría que el total
-- cambió, pero no qué renglones había antes, cuáles quedaron ni quién lo hizo.
create table order_item_edits (
  id              bigserial primary key,
  order_id        uuid not null references orders(id) on delete cascade,
  -- Un doble clic manda la misma clave y devuelve el resultado anterior sin volver a editar.
  idempotency_key text not null unique,
  staff_id        uuid references staff_users(id) on delete set null,
  reason          text,
  items_before    jsonb not null,
  items_after     jsonb not null,
  subtotal_before integer not null,
  subtotal_after  integer not null,
  discount_before integer not null,
  discount_after  integer not null,
  total_before    integer not null,
  total_after     integer not null,
  created_at      timestamptz not null default now()
);
create index order_item_edits_order_idx on order_item_edits(order_id, created_at desc);

alter table order_item_edits enable row level security;
create policy pdp_app_all on order_item_edits for all to pdp_app using (true) with check (true);

-- Renglones del pedido en la forma que se guarda en la bitácora.
create or replace function order_items_snapshot(p_order_id uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_item_id', id, 'product_id', product_id, 'product_name', product_name,
           'qty', qty, 'unit_price_cents', unit_price_cents, 'discount_cents', discount_cents,
           'total_cents', total_cents, 'notes', notes) order by sort_order), '[]'::jsonb)
    from order_items where order_id = p_order_id
$$;

/*
 * edit_order_items(jsonb) → jsonb
 *
 * Entrada:  { order_id, idempotency_key, reason?,
 *             items: [{ order_item_id?, product_id?, qty, notes? }] }
 *
 * `items` es la LISTA FINAL del pedido, no un diff:
 *   · un renglón con `order_item_id` conserva su precio (el que se pactó) y cambia su cantidad;
 *   · un renglón existente que no viene en la lista se QUITA;
 *   · un renglón sin `order_item_id` es un producto NUEVO, al precio vigente del canal del pedido.
 * Cambiar un producto por otro es quitar uno y agregar el otro.
 *
 * Devuelve: { order_id, folio, subtotal_cents, discount_cents, tax_cents, total_cents, paid_cents,
 *             balance_cents, payment_status, sale_id, duplicate }
 *
 * Transaccional e idempotente, con la fila del pedido bloqueada.
 */
create or replace function edit_order_items(p jsonb) returns jsonb
language plpgsql as $$
declare
  o                orders%rowtype;
  bs               business_settings%rowtype;
  v_order_id       uuid := jsonb_uuid(p, 'order_id');
  v_idem           text := nullif(p->>'idempotency_key', '');
  v_staff          uuid := current_staff_id();
  v_prev           order_item_edits%rowtype;
  v_price_channel  price_channel;
  v_item           jsonb;
  v_oi             order_items%rowtype;
  v_oi_id          uuid;
  v_product        products%rowtype;
  v_qty            numeric;
  v_unit           integer;
  v_line_disc      integer;
  v_line_total     integer;
  v_sort           integer := 0;
  v_keep           uuid[] := '{}';
  v_on_hand        numeric;
  v_before         jsonb;
  v_subtotal       integer;
  v_coupon         coupons%rowtype;
  v_reward         rewards%rowtype;
  v_recalc         integer := 0;
  v_discount       integer;
  v_tax            integer := 0;
  v_total          integer;
  v_status         payment_status;
  v_sale_id        uuid;
begin
  if v_order_id is null then
    raise exception 'Falta el pedido' using errcode = 'check_violation';
  end if;
  if v_idem is null then
    raise exception 'Falta la clave de idempotencia' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'El pedido necesita al menos un producto: para quitarlos todos, cancélalo'
      using errcode = 'check_violation';
  end if;

  -- Defensa en profundidad: la ruta ya exige el permiso, pero la regla de quién puede vive aquí.
  if v_staff is null or not exists (
       select 1 from staff_users su
         join role_permissions rp on rp.role_key = su.role_key
        where su.id = v_staff and su.is_active and su.deleted_at is null
          and rp.permission_key = 'orders.edit_items') then
    raise exception 'No tienes permiso para editar los productos de un pedido'
      using errcode = 'insufficient_privilege';
  end if;

  -- Reintento de la MISMA operación: se devuelve el estado actual, sin volver a editar.
  select * into v_prev from order_item_edits where idempotency_key = v_idem;
  if v_prev.id is not null then
    select * into o from orders where id = v_prev.order_id;
    return jsonb_build_object(
      'order_id', o.id, 'folio', o.folio,
      'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents,
      'tax_cents', o.tax_cents, 'total_cents', o.total_cents, 'paid_cents', o.paid_cents,
      'balance_cents', greatest(o.total_cents - o.paid_cents, 0),
      'payment_status', o.payment_status::text,
      'sale_id', (select id from sales where order_id = o.id and voided_at is null),
      'duplicate', true);
  end if;

  select * into o from orders where id = v_order_id for update;
  if o.id is null then
    raise exception 'El pedido no existe' using errcode = 'foreign_key_violation';
  end if;

  -- Las mismas barreras que `add_order_items` (0084).
  if exists (select 1 from sales where order_id = o.id and voided_at is null) then
    raise exception 'El pedido % ya está cobrado: un cambio ahí es una devolución o una venta nueva', o.folio
      using errcode = 'check_violation';
  end if;
  if o.status in ('cancelled', 'refunded') then
    raise exception 'El pedido % está %', o.folio, o.status using errcode = 'check_violation';
  end if;
  if o.status in ('delivered', 'completed') then
    raise exception 'El pedido % ya se entregó', o.folio using errcode = 'check_violation';
  end if;
  /*
   * Un pago en curso (link de Mercado Pago abierto, terminal cobrando) se calculó sobre el total de
   * antes. Si el pedido cambia mientras tanto, ese pago llega por un monto que ya no corresponde.
   */
  if exists (select 1 from payments where order_id = o.id and status in ('pending', 'authorized')) then
    raise exception 'El pedido % tiene un pago en proceso: espera a que se confirme o se cancele', o.folio
      using errcode = 'check_violation';
  end if;

  select * into bs from business_settings where id = 1;
  v_price_channel := (case when o.channel = 'pos' then 'pos' else 'web' end)::price_channel;
  v_before := order_items_snapshot(o.id);

  -- Primero se validan todos los renglones existentes que se conservan: que sean de ESTE pedido
  -- y que no vengan dos veces.
  for v_item in select * from jsonb_array_elements(p->'items') loop
    v_oi_id := jsonb_uuid(v_item, 'order_item_id');
    if v_oi_id is not null then
      if v_oi_id = any(v_keep) then
        raise exception 'Un renglón viene repetido en la edición' using errcode = 'check_violation';
      end if;
      if not exists (select 1 from order_items where id = v_oi_id and order_id = o.id) then
        raise exception 'El producto no pertenece a este pedido' using errcode = 'check_violation';
      end if;
      v_keep := v_keep || v_oi_id;
    end if;
  end loop;

  -- Lo que no viene en la lista final se quita.
  delete from order_items where order_id = o.id and not (id = any(v_keep));

  for v_item in select * from jsonb_array_elements(p->'items') loop
    v_oi_id := jsonb_uuid(v_item, 'order_item_id');
    v_qty := (v_item->>'qty')::numeric;
    v_sort := v_sort + 1;

    if v_oi_id is not null then
      -- Renglón que se conserva: mismo producto, mismo precio pactado; cambia la cantidad.
      select * into v_oi from order_items where id = v_oi_id for update;
      if v_qty is null or v_qty <= 0 then
        raise exception 'Cantidad inválida para "%": para quitarlo, sácalo de la lista', v_oi.product_name
          using errcode = 'check_violation';
      end if;

      -- Subir la cantidad de algo agotado tiene el mismo problema que agregarlo (ver 0084).
      if v_qty > v_oi.qty and v_oi.product_id is not null then
        select * into v_product from products where id = v_oi.product_id;
        if v_product.track_stock and not v_product.allow_preorder and not bs.allow_negative_stock then
          select on_hand into v_on_hand from inventory_levels where product_id = v_product.id;
          if coalesce(v_on_hand, 0) < v_qty then
            raise exception 'Producto "%" no alcanza: hay %, se piden %', v_product.name,
              coalesce(v_on_hand, 0), v_qty using errcode = 'check_violation';
          end if;
        end if;
      end if;

      -- Un descuento de renglón se ajusta en la misma proporción que la cantidad.
      v_line_disc := case when v_oi.qty > 0 then round(v_oi.discount_cents * v_qty / v_oi.qty)::integer
                          else 0 end;
      v_line_total := greatest(round(v_oi.unit_price_cents * v_qty)::integer - v_line_disc, 0);
      update order_items
         set qty = v_qty, discount_cents = v_line_disc, total_cents = v_line_total,
             notes = case when v_item ? 'notes' then nullif(v_item->>'notes', '') else notes end,
             sort_order = v_sort
       where id = v_oi_id;
    else
      -- Producto nuevo: mismas reglas que `add_order_items`.
      select * into v_product from products
       where id = jsonb_uuid(v_item, 'product_id') and deleted_at is null;
      if v_product.id is null then
        raise exception 'Producto % no existe', v_item->>'product_id' using errcode = 'foreign_key_violation';
      end if;
      if not v_product.is_active then
        raise exception 'Producto "%" no está disponible', v_product.name using errcode = 'check_violation';
      end if;
      if v_qty is null or v_qty <= 0 then
        raise exception 'Cantidad inválida para "%"', v_product.name using errcode = 'check_violation';
      end if;
      if v_product.track_stock and not v_product.allow_preorder and not bs.allow_negative_stock then
        select on_hand into v_on_hand from inventory_levels where product_id = v_product.id;
        if coalesce(v_on_hand, 0) < v_qty then
          raise exception 'Producto "%" no alcanza: hay %, se piden %', v_product.name,
            coalesce(v_on_hand, 0), v_qty using errcode = 'check_violation';
        end if;
      end if;
      v_unit := current_price_cents(v_product.id, v_price_channel);
      if v_unit is null then
        raise exception 'Producto "%" no tiene precio configurado', v_product.name using errcode = 'check_violation';
      end if;
      insert into order_items(order_id, product_id, product_name, variant_label, qty, unit_price_cents,
                              discount_cents, total_cents, unit_cost_cents, notes, sort_order)
      values (o.id, v_product.id, v_product.name, v_product.variant_label, v_qty, v_unit,
              0, round(v_unit * v_qty)::integer, product_cost_cents(v_product.id),
              nullif(v_item->>'notes', ''), v_sort);
    end if;
  end loop;

  select coalesce(sum(total_cents), 0) into v_subtotal from order_items where order_id = o.id;

  -- ── Descuento: nunca sube (ver la nota de arriba) ──
  if o.coupon_id is not null then
    select * into v_coupon from coupons where id = o.coupon_id;
    if v_coupon.id is not null then
      if v_subtotal < v_coupon.min_subtotal_cents then
        raise exception 'El cupón % pide una compra mínima de $%: el pedido quedaría en $%',
          v_coupon.code, round(v_coupon.min_subtotal_cents / 100.0, 2), round(v_subtotal / 100.0, 2)
          using errcode = 'check_violation';
      end if;
      if v_coupon.kind = 'free_product'
         and not exists (select 1 from order_items where order_id = o.id and product_id = v_coupon.product_id) then
        raise exception 'El cupón % regala un producto que ya no está en el pedido', v_coupon.code
          using errcode = 'check_violation';
      end if;
      v_recalc := v_recalc + case v_coupon.kind
        when 'pct' then round(v_subtotal * v_coupon.value_bps / 10000.0)::integer
        when 'amount' then least(v_coupon.value_cents, v_subtotal)
        when 'free_product' then coalesce((select min(unit_price_cents) from order_items
                                            where order_id = o.id and product_id = v_coupon.product_id), 0)
        else 0 end;
    end if;
  end if;
  if o.reward_redemption_id is not null then
    select r.* into v_reward from reward_redemptions rr join rewards r on r.id = rr.reward_id
     where rr.id = o.reward_redemption_id;
    if v_reward.id is not null then
      if v_reward.kind = 'free_product'
         and not exists (select 1 from order_items where order_id = o.id and product_id = v_reward.product_id) then
        raise exception 'La recompensa del cliente regala un producto que ya no está en el pedido'
          using errcode = 'check_violation';
      end if;
      v_recalc := v_recalc + case v_reward.kind
        when 'discount_pct' then round(v_subtotal * v_reward.value_bps / 10000.0)::integer
        when 'discount_amount' then least(v_reward.value_cents, v_subtotal)
        when 'free_product' then coalesce((select min(unit_price_cents) from order_items
                                            where order_id = o.id and product_id = v_reward.product_id), 0)
        else 0 end;
    end if;
  end if;
  if o.coupon_id is null and o.reward_redemption_id is null then
    -- Descuento sin origen conocido (pedidos importados): solo se acota al subtotal.
    v_recalc := o.discount_cents;
  end if;
  v_discount := least(o.discount_cents, v_recalc, v_subtotal);

  if not bs.prices_include_tax and bs.tax_rate_bps > 0 then
    v_tax := round((v_subtotal - v_discount) * bs.tax_rate_bps / 10000.0);
  end if;
  v_total := v_subtotal - v_discount + o.delivery_fee_cents + v_tax + o.tip_cents;

  if v_total <= 0 then
    raise exception 'El pedido no puede quedar en $0' using errcode = 'check_violation';
  end if;
  -- ANTICIPO: decisión de Max. Primero se reembolsa el excedente, después se edita.
  if v_total < o.paid_cents then
    raise exception 'El total nuevo ($%) queda por debajo de lo ya pagado ($%): registra primero el reembolso de $%',
      round(v_total / 100.0, 2), round(o.paid_cents / 100.0, 2), round((o.paid_cents - v_total) / 100.0, 2)
      using errcode = 'check_violation';
  end if;

  v_status := case when o.paid_cents <= 0 then 'pending'
                   when o.paid_cents < v_total then 'partial'
                   else 'paid' end;

  update orders set subtotal_cents = v_subtotal, discount_cents = v_discount, tax_cents = v_tax,
                    total_cents = v_total, payment_status = v_status
   where id = o.id;

  insert into order_item_edits(order_id, idempotency_key, staff_id, reason, items_before, items_after,
                               subtotal_before, subtotal_after, discount_before, discount_after,
                               total_before, total_after)
  values (o.id, v_idem, v_staff, nullif(trim(p->>'reason'), ''), v_before, order_items_snapshot(o.id),
          o.subtotal_cents, v_subtotal, o.discount_cents, v_discount, o.total_cents, v_total);

  perform emit_event('ORDER_ITEMS_EDITED', 'order', o.id::text,
                     jsonb_build_object('total_before', o.total_cents, 'total_after', v_total,
                                        'discount_before', o.discount_cents, 'discount_after', v_discount,
                                        'reason', nullif(trim(p->>'reason'), ''), 'staff_id', v_staff));

  /*
   * El anticipo cubre EXACTO el pedido nuevo: queda pagado. Se registra la venta igual que cuando un
   * pago alcanza el total (`record_payment`): ahí se descuenta el stock, se canjea el cupón y se dan
   * los puntos. Si el stock no alcanza, `finalize_sale` lo rechaza y toda la edición se deshace.
   */
  if o.paid_cents > 0 and o.paid_cents = v_total then
    v_sale_id := finalize_sale(o.id, null);
  end if;

  return jsonb_build_object(
    'order_id', o.id, 'folio', o.folio,
    'subtotal_cents', v_subtotal, 'discount_cents', v_discount, 'tax_cents', v_tax,
    'total_cents', v_total, 'paid_cents', o.paid_cents,
    'balance_cents', greatest(v_total - o.paid_cents, 0),
    'payment_status', v_status::text, 'sale_id', v_sale_id, 'duplicate', false);
end $$;

grant execute on function edit_order_items(jsonb) to pdp_app;
grant execute on function order_items_snapshot(uuid) to pdp_app;
