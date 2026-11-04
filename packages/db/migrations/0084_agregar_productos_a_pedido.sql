-- 0084 — Agregar productos a un pedido que todavía no se ha cobrado.
--
-- El caso real: la persona viene a retirar su pedido y, ya en el mostrador, pide dos conchas más.
-- Hoy no hay forma de hacerlo: `order_items` solo se escribe al crear el pedido, así que el
-- mostrador tenía que cobrar aparte y entregar dos tickets.
--
-- LA FRONTERA, y es dura: `finalize_sale` es irreversible. Ahí se crea la fila de `sales` con el
-- total congelado, se descuenta el stock, se canjea el cupón, se aplica la recompensa, se otorgan
-- los puntos y se suma el gasto histórico del cliente. Si se agregaran renglones DESPUÉS, el total
-- del pedido se separaría del de la venta, el stock de lo nuevo no se descontaría nunca y los
-- puntos quedarían calculados sobre un total que ya no existe.
--
-- Por eso la condición no es una lista de estados sino una sola: **se puede agregar mientras no
-- exista venta para ese pedido**. Si ya la hay, lo extra es una venta nueva en el punto de venta,
-- no un parche sobre el pedido.
--
-- Dos decisiones de negocio, tomadas con Max el 2026-11-03:
--
--  · PRECIO: se cobra al precio del MISMO canal con el que se creó el pedido. Un pedido web
--    agrega a precio web. El ticket no puede mostrar dos precios distintos para el mismo pan.
--  · DESCUENTO: el cupón o la recompensa se CONGELAN en el monto que ya tenían. El cupón se
--    aplicó al pedido que se hizo, no al pan que se antojó al llegar; recalcularlo regalaría
--    margen y podría saltarse el tope del propio cupón. Solo se recalculan impuesto y total.

-- Registro de cada agregado: es a la vez la llave de idempotencia y la bitácora fina.
--
-- Hace falta porque `orders` tiene disparador de auditoría pero `order_items` NO: sin esta tabla
-- quedaría registrado que el total pasó de X a Y, pero no qué se agregó ni quién. En algo que
-- mueve dinero eso no alcanza.
create table order_item_additions (
  id              bigserial primary key,
  order_id        uuid not null references orders(id) on delete cascade,
  -- Un doble clic manda la misma clave y devuelve el resultado anterior en lugar de cobrar de más.
  idempotency_key text not null unique,
  staff_id        uuid references staff_users(id) on delete set null,
  -- Lo agregado, con el precio del momento: el precio del catálogo puede cambiar después.
  items           jsonb not null,
  subtotal_before integer not null,
  subtotal_after  integer not null,
  total_before    integer not null,
  total_after     integer not null,
  created_at      timestamptz not null default now()
);
create index order_item_additions_order_idx on order_item_additions(order_id, created_at desc);

alter table order_item_additions enable row level security;
create policy pdp_app_all on order_item_additions for all to pdp_app using (true) with check (true);

/*
 * add_order_items(jsonb) → jsonb
 *
 * Entrada:  { order_id, idempotency_key, items: [{ product_id, qty, notes? }] }
 * Devuelve: { order_id, folio, added, subtotal_cents, discount_cents, tax_cents, total_cents,
 *             paid_cents, balance_cents, payment_status, duplicate }
 *
 * Transaccional e idempotente, con la fila del pedido bloqueada: dos operadores agregando a la vez
 * no se pisan los totales.
 */
create or replace function add_order_items(p jsonb) returns jsonb
language plpgsql as $$
declare
  o                orders%rowtype;
  bs               business_settings%rowtype;
  v_order_id       uuid := jsonb_uuid(p, 'order_id');
  v_idem           text := nullif(p->>'idempotency_key', '');
  v_prev           order_item_additions%rowtype;
  v_price_channel  price_channel;
  v_item           jsonb;
  v_product        products%rowtype;
  v_qty            numeric;
  v_unit           integer;
  v_line_total     integer;
  v_sort           integer;
  v_added          jsonb := '[]'::jsonb;
  v_on_hand        numeric;
  v_subtotal       integer;
  v_tax            integer := 0;
  v_total          integer;
  v_status         payment_status;
begin
  if v_order_id is null then
    raise exception 'Falta el pedido' using errcode = 'check_violation';
  end if;
  if v_idem is null then
    raise exception 'Falta la clave de idempotencia' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'No hay productos que agregar' using errcode = 'check_violation';
  end if;

  -- Reintento de la MISMA operación: se devuelve lo que ya quedó registrado, sin agregar otra vez.
  select * into v_prev from order_item_additions where idempotency_key = v_idem;
  if v_prev.id is not null then
    select * into o from orders where id = v_prev.order_id;
    return jsonb_build_object(
      'order_id', o.id, 'folio', o.folio, 'added', v_prev.items,
      'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents,
      'tax_cents', o.tax_cents, 'total_cents', o.total_cents, 'paid_cents', o.paid_cents,
      'balance_cents', greatest(o.total_cents - o.paid_cents, 0),
      'payment_status', o.payment_status::text, 'duplicate', true);
  end if;

  select * into o from orders where id = v_order_id for update;
  if o.id is null then
    raise exception 'El pedido no existe' using errcode = 'foreign_key_violation';
  end if;

  -- La venta ya existe: el total está congelado y el stock descontado. Ver la nota de arriba.
  if exists (select 1 from sales where order_id = o.id and voided_at is null) then
    raise exception 'El pedido % ya está cobrado: lo adicional se cobra como venta nueva', o.folio
      using errcode = 'check_violation';
  end if;
  if o.status in ('cancelled', 'refunded') then
    raise exception 'El pedido % está %', o.folio, o.status using errcode = 'check_violation';
  end if;
  -- Ya se entregó: el pan salió del mostrador y lo que pida ahora es otra compra.
  if o.status in ('delivered', 'completed') then
    raise exception 'El pedido % ya se entregó', o.folio using errcode = 'check_violation';
  end if;

  select * into bs from business_settings where id = 1;
  -- Mismo criterio que `create_order`: el canal del pedido manda sobre el precio.
  v_price_channel := (case when o.channel = 'pos' then 'pos' else 'web' end)::price_channel;
  select coalesce(max(sort_order), 0) into v_sort from order_items where order_id = o.id;

  for v_item in select * from jsonb_array_elements(p->'items') loop
    select * into v_product from products where id = (v_item->>'product_id')::uuid and deleted_at is null;
    if v_product.id is null then
      raise exception 'Producto % no existe', v_item->>'product_id' using errcode = 'foreign_key_violation';
    end if;
    if not v_product.is_active then
      raise exception 'Producto "%" no está disponible', v_product.name using errcode = 'check_violation';
    end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Cantidad inválida para "%"', v_product.name using errcode = 'check_violation';
    end if;

    /*
     * Agotado no se agrega. `finalize_sale` lo volvería a comprobar al cobrar —y es él quien
     * manda—, pero descubrirlo entonces, con el cliente enfrente y el cobro a medias, es el peor
     * momento posible. Misma regla que usa el punto de venta: `allow_preorder` separa "agotado" de
     * "todavía no horneado", porque lo que se hornea por encargo vive en cero casi siempre.
     */
    if v_product.track_stock and not v_product.allow_preorder and not bs.allow_negative_stock then
      select on_hand into v_on_hand from inventory_levels where product_id = v_product.id;
      if coalesce(v_on_hand, 0) <= 0 then
        raise exception 'Producto "%" está agotado', v_product.name using errcode = 'check_violation';
      end if;
    end if;

    v_unit := current_price_cents(v_product.id, v_price_channel);
    if v_unit is null then
      raise exception 'Producto "%" no tiene precio configurado', v_product.name using errcode = 'check_violation';
    end if;
    v_line_total := round(v_unit * v_qty)::integer;
    v_sort := v_sort + 1;

    insert into order_items(order_id, product_id, product_name, variant_label, qty, unit_price_cents,
                            discount_cents, total_cents, unit_cost_cents, notes, sort_order)
    values (o.id, v_product.id, v_product.name, v_product.variant_label, v_qty, v_unit,
            0, v_line_total, product_cost_cents(v_product.id), nullif(v_item->>'notes',''), v_sort);

    v_added := v_added || jsonb_build_object(
      'product_id', v_product.id, 'product_name', v_product.name, 'qty', v_qty,
      'unit_price_cents', v_unit, 'total_cents', v_line_total);
  end loop;

  -- Totales. El descuento NO se toca: ver la nota de arriba.
  select coalesce(sum(total_cents), 0) into v_subtotal from order_items where order_id = o.id;
  if not bs.prices_include_tax and bs.tax_rate_bps > 0 then
    v_tax := round((v_subtotal - o.discount_cents) * bs.tax_rate_bps / 10000.0);
  end if;
  v_total := v_subtotal - o.discount_cents + o.delivery_fee_cents + v_tax + o.tip_cents;

  -- El pedido vuelve a tener saldo: lo pagado antes era un anticipo sobre un total menor.
  v_status := case when o.paid_cents <= 0 then 'pending'
                   when o.paid_cents < v_total then 'partial'
                   else o.payment_status end;

  update orders set subtotal_cents = v_subtotal, tax_cents = v_tax, total_cents = v_total,
                    payment_status = v_status
   where id = o.id;

  insert into order_item_additions(order_id, idempotency_key, staff_id, items,
                                   subtotal_before, subtotal_after, total_before, total_after)
  values (o.id, v_idem, current_staff_id(), v_added,
          o.subtotal_cents, v_subtotal, o.total_cents, v_total);

  perform emit_event('ORDER_ITEMS_ADDED', 'order', o.id::text,
                     jsonb_build_object('items', v_added, 'total_before', o.total_cents,
                                        'total_after', v_total, 'staff_id', current_staff_id()));

  return jsonb_build_object(
    'order_id', o.id, 'folio', o.folio, 'added', v_added,
    'subtotal_cents', v_subtotal, 'discount_cents', o.discount_cents, 'tax_cents', v_tax,
    'total_cents', v_total, 'paid_cents', o.paid_cents,
    'balance_cents', greatest(v_total - o.paid_cents, 0),
    'payment_status', v_status::text, 'duplicate', false);
end $$;

grant execute on function add_order_items(jsonb) to pdp_app;
