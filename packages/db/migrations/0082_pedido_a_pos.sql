-- 0082_pedido_a_pos.sql — Enviar un pedido guardado al punto de venta para cobrar su saldo.
--
-- Lo que NO hace falta inventar, porque ya existe y está probado:
--   · La relación pedido ↔ venta ↔ pagos: `sales.order_id` y `payments.order_id`, ambos NOT NULL.
--   · El cobro: `record_payment(jsonb)` bloquea el pedido con `for update`, es idempotente por
--     `idempotency_key` y por `provider+external_id`, rechaza pedidos cancelados, rechaza que la
--     suma exceda el total, acumula en `paid_cents`, marca `partial` o `paid`, y solo llama a
--     `finalize_sale` cuando el saldo queda cubierto. Los anticipos ya funcionan.
--   · La caja: `pos_checkout` valida que esté abierta; `pedidos/actions.ts` ya asocia el cobro de
--     un pedido a la sesión abierta para que el corte no salga con diferencia falsa.
--   · Cancelar un cobro pendiente: `cancel_pending_pos_order`.
--
-- Lo único que falta es ESTADO: distinguir "elegible para cobrar" de "ya enviado al punto de
-- venta", que es lo que decide si el detalle muestra «Enviar a Punto de Venta» u «Abrir en Punto
-- de Venta», y lo que permite listar los pendientes sin depender de memoria, URL ni navegador.
--
-- Dos columnas nullable y una función. No se toca ninguna columna existente, no se migra ningún
-- dato y nada cambia para los pedidos que ya están en la base: sin `pos_queued_at` un pedido se
-- comporta exactamente como hoy.
--
-- Reversión: `alter table orders drop column pos_queued_at, drop column pos_queued_by;`
-- y `drop function queue_order_for_pos(uuid);`. No hay pérdida de datos de negocio: la columna
-- solo registra que alguien pulsó un botón.

alter table orders
  add column if not exists pos_queued_at timestamptz,
  add column if not exists pos_queued_by uuid references staff_users(id) on delete set null;

comment on column orders.pos_queued_at is
  'Cuándo se envió al punto de venta para cobrar. Null = no enviado. No implica pago ni entrega.';
comment on column orders.pos_queued_by is
  'Quién lo envió. Se conserva aunque el usuario se desactive (on delete set null).';

-- La cola del punto de venta se consulta por aquí, así que el índice cubre justo eso: enviados,
-- con saldo y sin cancelar. Parcial para que no crezca con el histórico ya cobrado.
create index if not exists orders_pos_queue_idx
  on orders (pos_queued_at desc)
  where pos_queued_at is not null
    and payment_status <> 'paid'
    and status not in ('cancelled', 'refunded');

/*
 * Envía un pedido al punto de venta. Idempotente a propósito: dos clics, un reintento, una recarga
 * o dos operadores a la vez recuperan el MISMO pedido en cola; no se crea nada duplicado porque no
 * se crea nada — solo se marca una fecha.
 *
 * Deliberadamente NO cobra, NO abre caja, NO registra pagos, NO descuenta inventario, NO reenvía a
 * producción y NO emite comprobantes. Enviar no es cobrar.
 *
 * El bloqueo de fila evita que dos operadores simultáneos escriban `pos_queued_by` distinto y que
 * uno lea un saldo que el otro acaba de cambiar.
 */
create or replace function queue_order_for_pos(p_order_id uuid) returns jsonb
language plpgsql as $$
declare
  o orders%rowtype;
  v_saldo integer;
  v_sale_id uuid;
  v_ya boolean;
begin
  select * into o from orders where id = p_order_id for update;
  if o.id is null then
    raise exception 'Pedido no existe' using errcode = 'no_data_found';
  end if;

  if o.status in ('cancelled', 'refunded') then
    raise exception 'El pedido está %, no se puede cobrar', o.status using errcode = 'check_violation';
  end if;

  -- El saldo es la única fuente de verdad del "cuánto falta": total menos lo ya pagado. Los
  -- reembolsos no lo reabren (eso es un flujo aparte, record_refund), así que no se suman aquí.
  v_saldo := o.total_cents - o.paid_cents;
  if v_saldo <= 0 then
    select id into v_sale_id from sales where order_id = o.id and voided_at is null;
    return jsonb_build_object(
      'queued', false, 'reason', 'already_paid', 'order_id', o.id, 'folio', o.folio,
      'balance_cents', 0, 'sale_id', v_sale_id, 'payment_status', o.payment_status
    );
  end if;

  v_ya := o.pos_queued_at is not null;
  if not v_ya then
    update orders
       set pos_queued_at = now(), pos_queued_by = current_staff_id()
     where id = o.id;
    perform emit_event('ORDER_QUEUED_FOR_POS', 'order', o.id::text,
                       jsonb_build_object('folio', o.folio, 'balance_cents', v_saldo));
  end if;

  return jsonb_build_object(
    'queued', true, 'already', v_ya, 'order_id', o.id, 'folio', o.folio,
    'balance_cents', v_saldo, 'total_cents', o.total_cents, 'paid_cents', o.paid_cents,
    'payment_status', o.payment_status, 'status', o.status
  );
end $$;

revoke all on function queue_order_for_pos(uuid) from public;
grant execute on function queue_order_for_pos(uuid) to pdp_app;
