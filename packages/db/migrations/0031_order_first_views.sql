-- Pedidos "sin ver": primera vez que alguien del equipo abre el detalle de un pedido.
-- Tabla aparte (aditiva): no cambia orders, su auditoría ni su updated_at. El contador del sidebar del CRM cuenta
-- los pedidos que llegaron solos (web, Instagram, WhatsApp sin staff) y que nadie ha abierto todavía.

create table order_first_views (
  order_id   uuid primary key references orders(id) on delete cascade,
  staff_id   uuid references staff_users(id) on delete set null,
  viewed_at  timestamptz not null default now()
);

-- Los pedidos que ya existen al publicar esta migración no se anuncian como nuevos.
insert into order_first_views (order_id, staff_id, viewed_at)
select id, null, placed_at from orders
on conflict (order_id) do nothing;

-- Búsqueda rápida del contador: pedidos recientes que llegaron sin staff.
create index orders_unattended_idx on orders (placed_at desc)
  where created_by is null and status not in ('cancelled', 'refunded');

-- Misma política que el resto del esquema (0009): RLS + acceso solo para pdp_app.
alter table order_first_views enable row level security;
create policy pdp_app_all on order_first_views for all to pdp_app using (true) with check (true);
grant select, insert, update, delete on order_first_views to pdp_app;
