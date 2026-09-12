-- 0020_pos_register.sql — Apoyo al POS y caja: resumen de sesión de caja y cancelación de cobros pendientes.
-- Aditiva. No modifica tablas ni funciones existentes.

-- Resumen en vivo de una sesión de caja (abierta o cerrada) para /caja y el corte impreso.
-- Cuenta pagos efectivamente cobrados (paid/partially_refunded/refunded) y descuenta reembolsos completados.
create or replace function register_session_summary(p_session_id uuid) returns jsonb
language sql stable as $$
  with pays as (
    select method, amount_cents
    from payments
    where register_session_id = p_session_id and status in ('paid','partially_refunded','refunded')
  ),
  refs as (
    select p.method, r.amount_cents
    from refunds r join payments p on p.id = r.payment_id
    where p.register_session_id = p_session_id and r.status = 'completed'
  ),
  s as (
    select count(*) filter (where voided_at is null)::int as sales_count,
           count(*) filter (where voided_at is not null)::int as voided_count,
           coalesce(sum(total_cents) filter (where voided_at is null), 0)::int as sales_total_cents,
           coalesce(sum(items_count) filter (where voided_at is null), 0)::numeric as items_count
    from sales where register_session_id = p_session_id
  )
  select jsonb_build_object(
    'session_id', rs.id,
    'status', rs.status,
    'opened_at', rs.opened_at,
    'closed_at', rs.closed_at,
    'opening_cash_cents', rs.opening_cash_cents,
    'sales_count', s.sales_count,
    'voided_count', s.voided_count,
    'sales_total_cents', s.sales_total_cents,
    'items_count', s.items_count,
    'cash_cents', coalesce((select sum(amount_cents) from pays where method = 'cash'), 0),
    'card_cents', coalesce((select sum(amount_cents) from pays where method = 'card_terminal'), 0),
    'transfer_cents', coalesce((select sum(amount_cents) from pays where method = 'transfer'), 0),
    'mercadopago_cents', coalesce((select sum(amount_cents) from pays where method = 'mercadopago'), 0),
    'other_cents', coalesce((select sum(amount_cents) from pays where method not in ('cash','card_terminal','transfer','mercadopago')), 0),
    'refunds_cash_cents', coalesce((select sum(amount_cents) from refs where method = 'cash'), 0),
    'refunds_other_cents', coalesce((select sum(amount_cents) from refs where method <> 'cash'), 0),
    'expected_cash_cents', register_expected_cash(rs.id),
    'counted_cash_cents', rs.counted_cash_cents,
    'difference_cents', rs.difference_cents
  )
  from register_sessions rs cross join s
  where rs.id = p_session_id
$$;

-- Cancela un pedido del POS que quedó esperando confirmación (Mercado Pago Point/QR) y nunca se concretó.
-- Si la venta ya existe (el webhook confirmó el pago) NO cancela: devuelve sale_id para que el POS lo muestre como cobrado.
create or replace function cancel_pending_pos_order(p_order_id uuid, p_reason text default 'Cobro cancelado en POS') returns jsonb
language plpgsql as $$
declare
  o orders%rowtype;
  v_sale_id uuid;
  n integer;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then raise exception 'Pedido no existe'; end if;
  select id into v_sale_id from sales where order_id = p_order_id and voided_at is null;
  if v_sale_id is not null then
    return jsonb_build_object('cancelled', false, 'sale_id', v_sale_id, 'status', o.status);
  end if;
  if o.status in ('cancelled','refunded') then
    return jsonb_build_object('cancelled', true, 'already', true, 'status', o.status);
  end if;
  update payments set status = 'cancelled', failed_at = now(), external_status = coalesce(external_status, 'cancelled_by_pos')
   where order_id = p_order_id and status in ('pending','authorized');
  get diagnostics n = row_count;
  perform change_order_status(p_order_id, 'cancelled', p_reason);
  return jsonb_build_object('cancelled', true, 'payments_cancelled', n, 'status', 'cancelled');
end $$;
