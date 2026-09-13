-- 0015_audit_infra.sql — Auditoría de infraestructura (docs/audit/infra.md).
-- Aditiva e idempotente (create or replace / if not exists / revoke-grant repetibles). La app anterior sigue funcionando.
--
--  1) apply_mercadopago_payment: concilia el monto acreditado por Mercado Pago con el saldo del pedido y deja
--     alertas (notifications kind 'payment_mismatch' / 'payment_on_cancelled_order') en vez de reventar y reintentar
--     8 veces un evento que nunca va a prosperar (pedido cancelado, pedido ya pagado, sobrepago).
--  2) job_runs: un lock 'running' de más de 15 min se libera al insertar el siguiente run del mismo lock_key.
--     Cubre a los crons que no usan runJob() (customer-events no liberaba locks huérfanos: un proceso muerto lo
--     dejaba en 409 para siempre).
--  3) Índice para que webhooks-retry recupere eventos atorados en 'processing'.
--  4) Privilegio por defecto global de EXECUTE (lo existente ya lo cierran 0080 y _post_migrate.sql): los defaults
--     IN SCHEMA de 0009/0080 no pueden quitar el EXECUTE por omisión de PUBLIC en funciones nuevas.

-- ── 1) Alertas de conciliación + apply_mercadopago_payment ──────────────────
create or replace function notify_payment_issue(p_order orders, p_kind text, p_title text, p_body text, p_payload jsonb)
returns void language plpgsql as $$
begin
  insert into notifications(kind, severity, title, body, entity, entity_id)
  select p_kind, 'error', p_title, p_body, 'order', p_order.id::text
  where not exists (
    select 1 from notifications n
    where n.kind = p_kind and n.entity = 'order' and n.entity_id = p_order.id::text and n.read_at is null
      and n.body = p_body
  );
  perform emit_event(upper(p_kind), 'order', p_order.id::text, p_payload || jsonb_build_object('folio', p_order.folio));
end $$;

-- p: {order_id, external_id, mp_status, amount_cents, method?, raw?}
create or replace function apply_mercadopago_payment(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_status payment_status;
  v_mp text := lower(coalesce(p->>'mp_status', ''));
  v_existing payments%rowtype;
  o orders%rowtype;
  v_res jsonb;
  v_amount integer := jsonb_int(p, 'amount_cents');
  v_due integer;
  v_meta jsonb := coalesce(p->'raw', '{}'::jsonb);
  v_mismatch boolean := false;
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
  select * into o from orders where id = jsonb_uuid(p, 'order_id') for update;
  if o.id is null then raise exception 'Pedido no existe'; end if;

  if v_existing.id is null then
    -- Primer aviso de este pago.
    if o.status in ('cancelled','refunded') then
      if v_status in ('paid','refunded') then
        -- Dinero real sobre un pedido cancelado: no se registra (record_payment lo rechaza); alerta para reembolsar.
        perform notify_payment_issue(o, 'payment_on_cancelled_order', 'Pago de Mercado Pago sobre pedido cancelado',
          format('Pedido %s está %s pero Mercado Pago reporta el pago %s en estado %s por $%s. Revisar en el panel de MP y reembolsar.',
                 o.folio, o.status, p->>'external_id', v_mp, to_char(coalesce(v_amount, 0) / 100.0, 'FM999999990.00')),
          jsonb_build_object('external_id', p->>'external_id', 'mp_status', v_mp, 'amount_cents', v_amount, 'order_status', o.status));
        return jsonb_build_object('applied_status', 'needs_refund', 'recorded', false, 'reason', 'pedido cancelado');
      end if;
      -- pending/rejected/cancelled sobre pedido cancelado: no hay nada que aplicar.
      return jsonb_build_object('applied_status', 'ignored', 'recorded', false, 'reason', 'pedido cancelado');
    end if;

    if v_status in ('paid','refunded') then
      v_due := o.total_cents - o.paid_cents;
      if v_due <= 0 then
        -- El pedido ya estaba pagado (p. ej. el cliente pagó dos veces): no se registra, alerta para reembolsar.
        perform notify_payment_issue(o, 'payment_mismatch', 'Pago duplicado de Mercado Pago',
          format('Pedido %s ya estaba pagado ($%s) y Mercado Pago acreditó otro pago %s por $%s. Reembolsar el duplicado.',
                 o.folio, to_char(o.paid_cents / 100.0, 'FM999999990.00'), p->>'external_id', to_char(coalesce(v_amount, 0) / 100.0, 'FM999999990.00')),
          jsonb_build_object('external_id', p->>'external_id', 'mp_status', v_mp, 'amount_cents', v_amount, 'paid_cents', o.paid_cents, 'total_cents', o.total_cents));
        return jsonb_build_object('applied_status', 'needs_refund', 'recorded', false, 'reason', 'pedido ya pagado');
      end if;
      if v_amount is null or v_amount <= 0 then raise exception 'Monto inválido' using errcode = 'check_violation'; end if;
      if v_amount <> v_due then
        -- Monto distinto al saldo del pedido. Menor: queda parcial (sin venta) y se alerta. Mayor: se registra el
        -- saldo del pedido (record_payment no permite exceder el total) y el excedente queda en la alerta y en metadata.
        v_mismatch := true;
        perform notify_payment_issue(o, 'payment_mismatch', 'Pago de Mercado Pago con monto distinto',
          format('Pedido %s: saldo $%s, Mercado Pago acreditó $%s en el pago %s (%s). %s',
                 o.folio, to_char(v_due / 100.0, 'FM999999990.00'), to_char(v_amount / 100.0, 'FM999999990.00'), p->>'external_id', v_mp,
                 case when v_amount > v_due then 'Reembolsar la diferencia.' else 'El pedido queda con pago parcial: cobrar la diferencia o cancelar.' end),
          jsonb_build_object('external_id', p->>'external_id', 'mp_status', v_mp, 'amount_cents', v_amount, 'expected_cents', v_due));
        v_meta := v_meta || jsonb_build_object('mp_amount_cents', v_amount, 'expected_cents', v_due, 'amount_mismatch', true);
        if v_amount > v_due then v_amount := v_due; end if;
      end if;
    end if;

    v_res := record_payment(jsonb_build_object('order_id', o.id, 'provider', 'mercadopago', 'method', coalesce(p->>'method', 'mercadopago'),
              'amount_cents', v_amount, 'status', case when v_status in ('refunded') then 'paid' else v_status end,
              'external_id', p->>'external_id', 'external_status', v_mp, 'metadata', v_meta));
    if v_status = 'refunded' then
      perform record_refund(jsonb_build_object('payment_id', v_res->>'payment_id', 'amount_cents', v_amount, 'reason', 'Reembolso Mercado Pago', 'external_id', p->>'external_id', 'idempotency_key', 'mp-refund:' || (p->>'external_id')));
    end if;
    return v_res || jsonb_build_object('applied_status', v_status, 'amount_mismatch', v_mismatch);
  end if;

  -- Ya existía: transición de estado del mismo pago
  if v_existing.status = v_status then
    return jsonb_build_object('payment_id', v_existing.id, 'duplicate', true, 'applied_status', v_status);
  end if;
  if v_existing.status in ('pending','authorized') and v_status = 'paid' then
    if o.status in ('cancelled','refunded') then
      perform notify_payment_issue(o, 'payment_on_cancelled_order', 'Pago de Mercado Pago sobre pedido cancelado',
        format('Pedido %s está %s y el pago %s pasó a approved por $%s. Revisar en el panel de MP y reembolsar.',
               o.folio, o.status, p->>'external_id', to_char(v_existing.amount_cents / 100.0, 'FM999999990.00')),
        jsonb_build_object('external_id', p->>'external_id', 'mp_status', v_mp, 'amount_cents', v_existing.amount_cents, 'order_status', o.status));
      update payments set external_status = v_mp, metadata = metadata || jsonb_build_object('needs_refund', true) where id = v_existing.id;
      return jsonb_build_object('payment_id', v_existing.id, 'applied_status', 'needs_refund', 'reason', 'pedido cancelado');
    end if;
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

-- ── 2) job_runs: liberar locks huérfanos al insertar un nuevo run ─────────────
create or replace function job_runs_release_stale_lock() returns trigger language plpgsql as $$
begin
  if new.status = 'running' and new.lock_key is not null then
    update job_runs set status = 'failed', finished_at = now(), error = 'lock expirado (proceso sin respuesta)'
    where lock_key = new.lock_key and status = 'running' and started_at < now() - interval '15 minutes';
  end if;
  return new;
end $$;
drop trigger if exists trg_job_runs_stale_lock on job_runs;
create trigger trg_job_runs_stale_lock before insert on job_runs for each row execute function job_runs_release_stale_lock();

-- ── 3) Eventos atorados en processing (función muerta a medio camino) ─────────
-- Sobre received_at (existe desde 0007): esta migración corre antes de 0060 en bases nuevas y después en las existentes.
create index if not exists webhook_events_processing_idx on webhook_events(provider, received_at) where status = 'processing';

-- ── 4) Privilegio por defecto GLOBAL de EXECUTE (complementa 0080 y _post_migrate.sql) ──
-- 0080 fija defaults IN SCHEMA public; esos se suman a los globales y no pueden quitar el EXECUTE que PUBLIC (y por
-- herencia anon/authenticated) recibe por omisión en cada función nueva. Sin esto, toda función queda expuesta desde
-- que su migración hace commit hasta que corre _post_migrate, y cualquier función creada fuera de `pnpm db:migrate`
-- (SQL Editor) queda expuesta hasta el siguiente deploy. Solo el nivel global (sin IN SCHEMA) lo corrige.
alter default privileges revoke execute on functions from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') and current_user <> 'postgres' then
    begin
      execute 'alter default privileges for role postgres revoke execute on functions from public';
    exception when insufficient_privilege then
      raise notice 'sin permiso para alterar defaults globales de postgres; se omite';
    end;
  end if;
end $$;
