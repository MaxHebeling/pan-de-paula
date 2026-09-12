-- 0005_commerce.sql — Puntos de retiro, reglas de pedido, calendario, pedidos, ventas, pagos, reembolsos, caja.

create type order_channel as enum ('web', 'pos', 'admin', 'instagram', 'whatsapp');
create type fulfillment_type as enum ('pickup', 'scheduled_pickup', 'delivery', 'preorder');
create type order_status as enum (
  'new', 'confirmed', 'payment_pending', 'paid', 'in_production', 'ready',
  'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'refunded'
);
create type payment_status as enum ('pending', 'authorized', 'partial', 'paid', 'failed', 'refunded', 'partially_refunded', 'cancelled');
create type payment_method as enum ('cash', 'mercadopago', 'card_terminal', 'transfer', 'points', 'other');
create type payment_provider as enum ('cash', 'mercadopago', 'manual');

create table pickup_points (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  city        text,
  notes       text,
  map_url     text,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Horarios de atención (por día de semana, 0=domingo)
create table business_hours (
  weekday   smallint primary key check (weekday between 0 and 6),
  is_open   boolean not null default true,
  opens_at  time,
  closes_at time
);
insert into business_hours(weekday, is_open, opens_at, closes_at) values
  (0, false, null, null), (1, true, '09:00', '18:00'), (2, true, '09:00', '18:00'),
  (3, true, '09:00', '18:00'), (4, true, '09:00', '18:00'), (5, true, '09:00', '18:00'), (6, true, '09:00', '14:00');

-- Ventanas de pedido: "recibimos pedidos lunes–miércoles hasta las 18:00; se entregan el viernes"
create table ordering_windows (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  fulfillment_type   fulfillment_type not null,
  order_weekdays     smallint[] not null,                 -- días en que se aceptan pedidos
  cutoff_time        time not null default '18:00',       -- hora límite el último día de la ventana
  fulfillment_weekday smallint not null check (fulfillment_weekday between 0 and 6),
  fulfillment_from   time,
  fulfillment_to     time,
  lead_days_min      integer not null default 1,          -- mínimo de días entre pedido y entrega
  max_orders         integer,                             -- cupo opcional por fecha
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_ordering_windows_updated before update on ordering_windows for each row execute function set_updated_at();
create trigger trg_audit_ordering_windows after insert or update or delete on ordering_windows for each row execute function audit_row_change();

-- Excepciones de calendario: feriados, vacaciones, cierres, días extra
create table calendar_exceptions (
  id          uuid primary key default gen_random_uuid(),
  date        date not null unique,
  is_closed   boolean not null default true,
  no_orders   boolean not null default true,        -- no se aceptan ni entregan pedidos ese día
  opens_at    time,
  closes_at   time,
  note        text,
  created_at  timestamptz not null default now()
);
create trigger trg_audit_calendar_exceptions after insert or update or delete on calendar_exceptions for each row execute function audit_row_change();

-- Folio legible por año: PDP-2026-000123
create sequence order_folio_seq;
create or replace function next_order_folio() returns text language sql as $$
  select 'PDP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_folio_seq')::text, 6, '0')
$$;

create table orders (
  id                  uuid primary key default gen_random_uuid(),
  folio               text not null unique default next_order_folio(),
  channel             order_channel not null,
  status              order_status not null default 'new',
  payment_status      payment_status not null default 'pending',
  fulfillment_type    fulfillment_type not null default 'pickup',
  customer_id         uuid references customers(id) on delete set null,
  customer_name       text,                       -- snapshot / cliente anónimo
  customer_phone      text,
  customer_email      citext,
  pickup_point_id     uuid references pickup_points(id) on delete set null,
  delivery_address    jsonb,
  scheduled_for       timestamptz,                -- fecha/hora de entrega o retiro
  ordering_window_id  uuid references ordering_windows(id) on delete set null,
  subtotal_cents      integer not null default 0 check (subtotal_cents >= 0),
  discount_cents      integer not null default 0 check (discount_cents >= 0),
  delivery_fee_cents  integer not null default 0 check (delivery_fee_cents >= 0),
  tax_cents           integer not null default 0 check (tax_cents >= 0),
  tip_cents           integer not null default 0 check (tip_cents >= 0),
  total_cents         integer not null default 0 check (total_cents >= 0),
  paid_cents          integer not null default 0 check (paid_cents >= 0),
  refunded_cents      integer not null default 0 check (refunded_cents >= 0),
  coupon_id           uuid references coupons(id) on delete set null,
  coupon_code         text,
  reward_redemption_id uuid references reward_redemptions(id) on delete set null,
  notes               text,
  internal_notes      text,
  source_ref          text,                       -- ej. id de conversación de Instagram
  created_by          uuid references staff_users(id) on delete set null,
  idempotency_key     text unique,
  placed_at           timestamptz not null default now(),
  confirmed_at        timestamptz,
  paid_at             timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint orders_total_chk check (total_cents = subtotal_cents - discount_cents + delivery_fee_cents + tax_cents + tip_cents)
);
create index orders_status_idx on orders(status, placed_at desc);
create index orders_customer_idx on orders(customer_id, placed_at desc);
create index orders_scheduled_idx on orders(scheduled_for) where status not in ('cancelled','refunded','completed','delivered');
create index orders_channel_idx on orders(channel, placed_at desc);
create index orders_phone_idx on orders(customer_phone);
create trigger trg_orders_updated before update on orders for each row execute function set_updated_at();
create trigger trg_audit_orders after insert or update or delete on orders for each row execute function audit_row_change();

alter table reward_redemptions add constraint reward_redemptions_order_fk foreign key (order_id) references orders(id) on delete set null;
alter table coupon_redemptions add constraint coupon_redemptions_order_fk foreign key (order_id) references orders(id) on delete set null;

create table order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id) on delete cascade,
  product_id       uuid references products(id) on delete set null,
  product_name     text not null,                 -- snapshot inmutable
  variant_label    text,
  qty              numeric(12,3) not null check (qty > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  discount_cents   integer not null default 0 check (discount_cents >= 0),
  total_cents      integer not null check (total_cents >= 0),
  unit_cost_cents  integer,                       -- snapshot del costo al momento de la venta
  notes            text,
  sort_order       integer not null default 0
);
create index order_items_order_idx on order_items(order_id);
create index order_items_product_idx on order_items(product_id);

create table order_status_history (
  id          bigserial primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  from_status order_status,
  to_status   order_status not null,
  note        text,
  staff_id    uuid references staff_users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index order_status_history_order_idx on order_status_history(order_id, created_at);

-- Caja
create table register_sessions (
  id                  uuid primary key default gen_random_uuid(),
  opened_by           uuid not null references staff_users(id),
  closed_by           uuid references staff_users(id),
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz,
  opening_cash_cents  integer not null default 0,
  expected_cash_cents integer,
  counted_cash_cents  integer,
  card_cents          integer,
  transfer_cents      integer,
  mercadopago_cents   integer,
  other_cents         integer,
  difference_cents    integer,
  notes               text,
  status              text not null default 'open' check (status in ('open','closed'))
);
create unique index register_sessions_open_idx on register_sessions(status) where status = 'open';
create trigger trg_audit_register_sessions after insert or update or delete on register_sessions for each row execute function audit_row_change();

-- Venta: registro financiero inmutable creado cuando un pedido se concreta (POS: al cobrar; web: al confirmarse el pago)
create table sales (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null unique references orders(id) on delete restrict,
  channel             order_channel not null,
  customer_id         uuid references customers(id) on delete set null,
  register_session_id uuid references register_sessions(id) on delete set null,
  staff_id            uuid references staff_users(id) on delete set null,
  sold_at             timestamptz not null default now(),
  subtotal_cents      integer not null,
  discount_cents      integer not null default 0,
  tax_cents           integer not null default 0,
  tip_cents           integer not null default 0,
  total_cents         integer not null,
  cost_cents          integer,                    -- suma de costos snapshot (null si falta costeo)
  items_count         numeric(12,3) not null default 0,
  voided_at           timestamptz,
  void_reason         text
);
create index sales_sold_at_idx on sales(sold_at desc);
create index sales_customer_idx on sales(customer_id, sold_at desc);
create index sales_session_idx on sales(register_session_id);
alter table loyalty_transactions add constraint loyalty_tx_sale_fk foreign key (sale_id) references sales(id) on delete set null;

create table payments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete restrict,
  provider          payment_provider not null,
  method            payment_method not null,
  status            payment_status not null default 'pending',
  amount_cents      integer not null check (amount_cents > 0),
  tendered_cents    integer,                      -- efectivo recibido
  change_cents      integer,                      -- cambio entregado
  currency          char(3) not null default 'MXN',
  external_id       text,                         -- id de pago en Mercado Pago
  external_status   text,
  reference         text,                         -- referencia de transferencia / folio terminal
  idempotency_key   text unique,
  metadata          jsonb not null default '{}'::jsonb,
  received_by       uuid references staff_users(id) on delete set null,
  register_session_id uuid references register_sessions(id) on delete set null,
  created_at        timestamptz not null default now(),
  confirmed_at      timestamptz,
  failed_at         timestamptz,
  updated_at        timestamptz not null default now()
);
create unique index payments_external_idx on payments(provider, external_id) where external_id is not null;
create index payments_order_idx on payments(order_id);
create index payments_session_idx on payments(register_session_id);
create index payments_status_idx on payments(status, created_at desc);
create trigger trg_payments_updated before update on payments for each row execute function set_updated_at();
create trigger trg_audit_payments after insert or update or delete on payments for each row execute function audit_row_change();

create table refunds (
  id            uuid primary key default gen_random_uuid(),
  payment_id    uuid not null references payments(id) on delete restrict,
  order_id      uuid not null references orders(id) on delete restrict,
  amount_cents  integer not null check (amount_cents > 0),
  reason        text,
  status        text not null default 'pending' check (status in ('pending','completed','failed')),
  external_id   text,
  idempotency_key text unique,
  staff_id      uuid references staff_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index refunds_order_idx on refunds(order_id);
create trigger trg_audit_refunds after insert or update or delete on refunds for each row execute function audit_row_change();

-- Devolución física (separada del reembolso financiero)
create table returns (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete restrict,
  order_item_id  uuid references order_items(id) on delete set null,
  product_id     uuid references products(id) on delete set null,
  qty            numeric(12,3) not null check (qty > 0),
  restock        boolean not null default false,   -- true => movimiento RETURN a inventario
  reason         text,
  staff_id       uuid references staff_users(id) on delete set null,
  created_at     timestamptz not null default now()
);

-- Comprobantes enviados
create table receipts (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  channel     text not null check (channel in ('email','whatsapp','print','pdf')),
  destination text,
  status      text not null default 'sent' check (status in ('queued','sent','failed')),
  error       text,
  created_at  timestamptz not null default now()
);
