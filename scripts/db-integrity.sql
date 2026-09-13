-- scripts/db-integrity.sql — Consultas de integridad de la base (SOLO LECTURA).
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-integrity.sql
--      (en producción con la URL del pooler; no escribe nada: solo select).
--
-- Cómo interpretar: cada bloque imprime un encabezado y las filas que VIOLAN el invariante.
-- El resultado sano es "(0 rows)" en todos los bloques marcados [0 filas], y un único "ok" en los [resumen].
-- Si algún bloque devuelve filas: NO corregir a mano en producción; abrir postmortem y usar la acción indicada.

\set ON_ERROR_STOP on
\pset footer on
\timing off

\echo
\echo '========================================================================'
\echo ' 1. Inventario: inventory_levels.on_hand debe ser la suma de inventory_movements  [0 filas]'
\echo '    Acción si hay filas: select rebuild_inventory_levels();  + postmortem (algo escribió fuera de las funciones).'
\echo '========================================================================'
select l.product_id, p.name, l.on_hand, m.total as movimientos, l.on_hand - m.total as diferencia
from inventory_levels l
join products p on p.id = l.product_id
join (select product_id, sum(qty) as total from inventory_movements group by product_id) m using (product_id)
where l.on_hand <> m.total
order by abs(l.on_hand - m.total) desc;

\echo
\echo ' 1b. Productos con movimientos pero sin fila en inventory_levels  [0 filas]  Acción: rebuild_inventory_levels().'
select m.product_id, sum(m.qty) as total_movimientos
from inventory_movements m left join inventory_levels l on l.product_id = m.product_id
where l.product_id is null group by m.product_id;

\echo
\echo '========================================================================'
\echo ' 2. Puntos: customers.points_balance debe igualar la suma del ledger loyalty_transactions  [0 filas]'
\echo '    Acción: revisar loyalty_post / merge_customers; corregir con loyalty_post(kind=adjust) documentado, nunca update directo.'
\echo '========================================================================'
select c.id, c.public_code, c.full_name, c.points_balance, coalesce(t.ledger, 0) as ledger, c.points_balance - coalesce(t.ledger, 0) as diferencia
from customers c
left join (select customer_id, sum(points) as ledger from loyalty_transactions group by customer_id) t on t.customer_id = c.id
where c.points_balance <> coalesce(t.ledger, 0)
order by abs(c.points_balance - coalesce(t.ledger, 0)) desc;

\echo
\echo '========================================================================'
\echo ' 3. Pagos: orders.paid_cents = suma de pagos paid/partially_refunded/refunded (los reembolsos van a refunded_cents)  [0 filas]'
\echo '    Nota: un pedido cancelado por void_sale queda con paid_cents=0 y sus pagos en cancelled (consistente).'
\echo '    Acción: conciliar contra el panel de Mercado Pago / corte de caja; no tocar payments a mano.'
\echo '========================================================================'
select o.id, o.folio, o.status, o.payment_status, o.paid_cents, coalesce(p.pagado, 0) as pagos, o.paid_cents - coalesce(p.pagado, 0) as diferencia
from orders o
left join (select order_id, sum(amount_cents) as pagado from payments where status in ('paid','partially_refunded','refunded') group by order_id) p on p.order_id = o.id
where o.paid_cents <> coalesce(p.pagado, 0)
order by o.placed_at desc;

\echo
\echo ' 3a. Reembolsos: orders.refunded_cents = suma de refunds no fallidos del pedido  [0 filas]'
select o.id, o.folio, o.refunded_cents, coalesce(r.s, 0) as reembolsos
from orders o left join (select order_id, sum(amount_cents) as s from refunds where status <> 'failed' group by order_id) r on r.order_id = o.id
where o.refunded_cents <> coalesce(r.s, 0);

\echo
\echo ' 3b. Pedidos marcados paid sin venta, o ventas vigentes cuyo pedido no está pagado/reembolsado  [0 filas]'
select o.id, o.folio, o.status, o.payment_status, o.paid_cents, o.total_cents, s.id as sale_id
from orders o left join sales s on s.order_id = o.id
where (o.payment_status = 'paid' and s.id is null and o.total_cents > 0)
   or (s.id is not null and s.voided_at is null and o.payment_status not in ('paid','partially_refunded','refunded'));

\echo
\echo ' 3c. Pagos que exceden el total del pedido  [0 filas]  (record_payment lo impide; aparecer aquí = escritura directa)'
select o.folio, o.total_cents, o.paid_cents from orders o where o.paid_cents > o.total_cents;

\echo
\echo ' 3d. Reembolsos que exceden el pago  [0 filas]'
select pm.id as payment_id, pm.amount_cents, sum(r.amount_cents) as reembolsado
from payments pm join refunds r on r.payment_id = pm.id and r.status <> 'failed'
group by pm.id, pm.amount_cents having sum(r.amount_cents) > pm.amount_cents;

\echo
\echo '========================================================================'
\echo ' 4. Cupones: coupons.uses_count debe igualar el número de coupon_redemptions  [0 filas]'
\echo '========================================================================'
select c.id, c.code, c.uses_count, coalesce(r.n, 0) as redenciones
from coupons c left join (select coupon_id, count(*) as n from coupon_redemptions group by coupon_id) r on r.coupon_id = c.id
where c.uses_count <> coalesce(r.n, 0);

\echo
\echo '========================================================================'
\echo ' 5. Clientes: total_orders = ventas no anuladas; total_spent_cents = esas ventas − reembolsos  [0 filas]'
\echo '    (void_sale, record_refund y merge_customers ajustan los contadores; una diferencia indica escritura directa)'
\echo '========================================================================'
select c.id, c.public_code, c.total_orders, coalesce(s.n, 0) as ventas, c.total_spent_cents,
       coalesce(s.t, 0) - coalesce(rf.t, 0) as esperado
from customers c
left join (select customer_id, count(*) as n, sum(total_cents) as t from sales where voided_at is null group by customer_id) s on s.customer_id = c.id
left join (select s2.customer_id, sum(r.amount_cents) as t from refunds r join sales s2 on s2.order_id = r.order_id and s2.voided_at is null
           where r.status <> 'failed' group by s2.customer_id) rf on rf.customer_id = c.id
where c.deleted_at is null and c.merged_into_id is null
  and (c.total_orders <> coalesce(s.n, 0) or c.total_spent_cents <> coalesce(s.t, 0) - coalesce(rf.t, 0));

\echo
\echo '========================================================================'
\echo ' 6. Huérfanos y duplicados  [resumen: todos los contadores en 0]'
\echo '========================================================================'
select
  (select count(*) from sales s left join orders o on o.id = s.order_id where o.id is null)                         as ventas_sin_pedido,
  (select count(*) from payments p left join orders o on o.id = p.order_id where o.id is null)                      as pagos_sin_pedido,
  (select count(*) from refunds r left join payments p on p.id = r.payment_id where p.id is null)                   as reembolsos_sin_pago,
  (select count(*) from order_items oi left join orders o on o.id = oi.order_id where o.id is null)                 as items_sin_pedido,
  (select count(*) from order_items oi left join products p on p.id = oi.product_id where oi.product_id is not null and p.id is null) as items_sin_producto,
  (select count(*) from (select order_id from sales group by order_id having count(*) > 1) d)                       as pedidos_con_dos_ventas,
  (select count(*) from (select provider, external_id from payments where external_id is not null group by 1, 2 having count(*) > 1) d) as pagos_externos_duplicados,
  (select count(*) from loyalty_transactions t left join customers c on c.id = t.customer_id where c.id is null)    as puntos_sin_cliente,
  (select count(*) from instagram_messages m left join instagram_conversations c on c.id = m.conversation_id where c.id is null) as ig_mensajes_sin_conversacion;

\echo
\echo '========================================================================'
\echo ' 7. Webhooks: eventos atorados o fallidos  [0 filas en operación sana; failed con attempts>=3 → runbook MP]'
\echo '    processing > 10 min = la función murió a medio camino; el cron webhooks-retry lo retoma solo.'
\echo '========================================================================'
select provider, external_id, event_type, status, attempts, received_at, last_attempt_at, left(last_error, 120) as last_error
from webhook_events
where status = 'failed'
   or (status in ('received','processing') and coalesce(last_attempt_at, received_at) < now() - interval '10 minutes')
order by received_at desc limit 50;

\echo
\echo ' 7b. Pedidos web con pago pendiente > 30 min  [revisar contra el panel de MP]'
select o.folio, o.placed_at, o.total_cents, o.payment_status, o.status,
       (select count(*) from payments p where p.order_id = o.id) as pagos
from orders o
where o.channel = 'web' and o.payment_status in ('pending','partial')
  and o.status not in ('cancelled','refunded') and o.placed_at < now() - interval '30 minutes'
order by o.placed_at;

\echo
\echo ' 7c. Alertas de conciliación de Mercado Pago sin atender (monto distinto, pedido cancelado o ya pagado)  [0 filas]'
\echo '     Acción: revisar el pago en el panel de MP; reembolsar o cobrar la diferencia; marcar leída la notificación.'
select created_at, kind, title, body, entity_id as order_id from notifications
where kind in ('payment_mismatch','payment_on_cancelled_order') and read_at is null order by created_at desc;

\echo
\echo '========================================================================'
\echo ' 8. Jobs: fallidos en 24 h o running > 1 h  [0 filas]  (running > 15 min se autolibera en la siguiente corrida)'
\echo '========================================================================'
select job_name, status, started_at, finished_at, left(error, 120) as error
from job_runs
where (status = 'failed' and started_at > now() - interval '24 hours')
   or (status = 'running' and started_at < now() - interval '1 hour')
order by started_at desc;

\echo
\echo ' 8b. Última corrida exitosa por job (webhooks-retry debe ser < 1 h; los demás < 26 h)'
select job_name, max(finished_at) filter (where status = 'succeeded') as ultimo_ok,
       now() - max(finished_at) filter (where status = 'succeeded') as hace
from job_runs group by job_name order by job_name;

\echo
\echo '========================================================================'
\echo ' 9. Seguridad: RLS y privilegios  [resumen: todos en 0]'
\echo '    tablas_sin_rls / tablas_sin_policy → 0009_security no se aplicó completo.'
\echo '    funciones_publicas → EXECUTE concedido a PUBLIC/anon/authenticated (0015 lo revoca; si reaparece, una migración creó funciones con otro rol).'
\echo '========================================================================'
select
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) as tablas_sin_rls,
  (select count(*) from pg_tables t where schemaname = 'public'
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename and p.policyname = 'pdp_app_all')) as tablas_sin_policy,
  (select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')) as grants_tabla_publicos,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (has_function_privilege('public', p.oid, 'execute')
        or (exists (select 1 from pg_roles where rolname = 'anon') and has_function_privilege('anon', p.oid, 'execute'))
        or (exists (select 1 from pg_roles where rolname = 'authenticated') and has_function_privilege('authenticated', p.oid, 'execute')))) as funciones_publicas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and exists (select 1 from pg_roles where rolname = 'pdp_app') and not has_function_privilege('pdp_app', p.oid, 'execute')) as funciones_sin_pdp_app,
  (select coalesce(bool_or(has_schema_privilege(r.rolname, 'public', 'usage')), false)::int from pg_roles r where r.rolname in ('anon','authenticated')) as anon_usage_schema;

\echo
\echo '========================================================================'
\echo ' 10. Migraciones: aplicadas vs esperadas  [comparar con `ls packages/db/migrations | wc -l` y con RELEASED]'
\echo '========================================================================'
select count(*) as migraciones_aplicadas, max(version) as ultima, max(applied_at) as ultima_fecha from schema_migrations;

\echo
\echo ' 10b. Checksums aplicados (para cotejar con packages/db/migrations/RELEASED: `shasum -a 256 <archivo>`)'
select version, name, checksum from schema_migrations order by version;

\echo
\echo '========================================================================'
\echo ' 11. Operación: caja abierta > 20 h, stock agotado en productos activos, notificaciones error sin leer'
\echo '========================================================================'
select id, opened_at, opened_by from register_sessions where status = 'open' and opened_at < now() - interval '20 hours';
select name, on_hand, low_stock_threshold, level from stock_status where track_stock and level <> 'ok' order by on_hand;
select kind, severity, count(*) from notifications where read_at is null and severity in ('warning','error') group by 1, 2 order by 2, 1;
\echo
\echo 'Fin. Sano = todos los bloques [0 filas] vacíos y los [resumen] en 0.'
