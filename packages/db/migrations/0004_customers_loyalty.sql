-- 0004_customers_loyalty.sql — Clientes, direcciones, fidelización (niveles, reglas, ledger), recompensas, cupones.

create sequence customer_code_seq start 1;

create table customers (
  id                  uuid primary key default gen_random_uuid(),
  public_code         text not null unique default ('PDP-' || lpad(nextval('customer_code_seq')::text, 6, '0')),
  qr_token            text not null unique default encode(gen_random_bytes(18), 'base64'),  -- opaco; se resuelve en backend
  full_name           text not null,
  phone               citext,
  email               citext,
  birthday            date,
  notes               text,
  tags                text[] not null default '{}',
  source              text not null default 'pos',     -- pos | web | qr | instagram | import | admin
  operational_consent boolean not null default true,
  marketing_consent   boolean not null default false,
  marketing_opt_out_at timestamptz,
  tier_key            text,                             -- fk lógico a loyalty_tiers.key (se asigna en 0004 más abajo)
  points_balance      integer not null default 0 check (points_balance >= 0),
  lifetime_points     integer not null default 0,
  total_orders        integer not null default 0,
  total_spent_cents   bigint not null default 0,
  first_purchase_at   timestamptz,
  last_purchase_at    timestamptz,
  favorite_product_id uuid references products(id) on delete set null,
  merged_into_id      uuid references customers(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index customers_phone_idx on customers(phone) where phone is not null and deleted_at is null and merged_into_id is null;
create unique index customers_email_idx on customers(email) where email is not null and deleted_at is null and merged_into_id is null;
create index customers_name_idx on customers using gin (to_tsvector('spanish', full_name));
create index customers_last_purchase_idx on customers(last_purchase_at desc nulls last);
create trigger trg_customers_updated before update on customers for each row execute function set_updated_at();
create trigger trg_audit_customers after insert or update or delete on customers for each row execute function audit_row_change();

create table customer_addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  label        text,
  street       text not null,
  neighborhood text,
  city         text,
  state        text,
  postal_code  text,
  references_note text,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now()
);
create index customer_addresses_customer_idx on customer_addresses(customer_id);

-- Niveles configurables
create table loyalty_tiers (
  key             text primary key,               -- new, frequent, vip, ambassador
  name            text not null,
  rank            smallint not null,
  min_orders      integer not null default 0,
  min_spent_cents bigint not null default 0,
  min_lifetime_points integer not null default 0,
  perks           text,
  color           text
);
alter table customers add constraint customers_tier_fk foreign key (tier_key) references loyalty_tiers(key) on delete set null;

insert into loyalty_tiers(key, name, rank, min_orders, min_spent_cents, perks, color) values
  ('new',        'Nuevo',      1, 0,   0,       'Bienvenida',                      'gray'),
  ('frequent',   'Frecuente',  2, 5,   150000,  'Acumula puntos dobles en tu cumpleaños', 'blue'),
  ('vip',        'VIP',        3, 15,  500000,  'Acceso anticipado a temporada',   'amber'),
  ('ambassador', 'Embajador',  4, 40,  1500000, 'Regalo trimestral',               'green');

-- Programa de puntos (singleton configurable)
create table loyalty_program (
  id                    smallint primary key default 1 check (id = 1),
  is_active             boolean not null default true,
  points_per_unit       integer not null default 1 check (points_per_unit >= 0),     -- puntos otorgados...
  unit_cents            integer not null default 1000 check (unit_cents > 0),        -- ...por cada N centavos (1000 = $10)
  min_purchase_cents    integer not null default 0,
  birthday_multiplier   numeric(4,2) not null default 2.0,
  signup_bonus_points   integer not null default 0,
  points_expire_days    integer,                                                       -- null = no expiran
  rounding              text not null default 'floor' check (rounding in ('floor','round')),
  updated_at            timestamptz not null default now()
);
insert into loyalty_program(id) values (1);
create trigger trg_loyalty_program_updated before update on loyalty_program for each row execute function set_updated_at();
create trigger trg_audit_loyalty_program after update on loyalty_program for each row execute function audit_row_change();

-- Bonos por producto (ej. 5 puntos extra por cada Croissant)
create table loyalty_product_bonuses (
  product_id    uuid primary key references products(id) on delete cascade,
  bonus_points  integer not null check (bonus_points >= 0),
  is_active     boolean not null default true
);

create type loyalty_tx_kind as enum ('earn', 'redeem', 'adjust', 'expire', 'bonus', 'reversal');

create table loyalty_transactions (
  id            bigserial primary key,
  customer_id   uuid not null references customers(id) on delete cascade,
  kind          loyalty_tx_kind not null,
  points        integer not null,                         -- positivo suma, negativo resta
  balance_after integer not null,
  sale_id       uuid,                                      -- fk se agrega en 0005
  redemption_id uuid,
  note          text,
  staff_id      uuid references staff_users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index loyalty_tx_customer_idx on loyalty_transactions(customer_id, created_at desc);

create type reward_kind as enum ('discount_pct', 'discount_amount', 'free_product', 'gift');

create table rewards (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  kind          reward_kind not null,
  points_cost   integer not null check (points_cost >= 0),
  value_bps     integer check (value_bps between 0 and 10000),   -- para discount_pct
  value_cents   integer check (value_cents >= 0),                 -- para discount_amount
  product_id    uuid references products(id) on delete set null, -- para free_product
  min_tier_key  text references loyalty_tiers(key) on delete set null,
  is_active     boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_rewards_updated before update on rewards for each row execute function set_updated_at();

create table reward_redemptions (
  id           uuid primary key default gen_random_uuid(),
  reward_id    uuid not null references rewards(id) on delete restrict,
  customer_id  uuid not null references customers(id) on delete cascade,
  points_spent integer not null,
  status       text not null default 'issued' check (status in ('issued','applied','cancelled','expired')),
  code         text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  order_id     uuid,                                     -- fk en 0005
  issued_at    timestamptz not null default now(),
  applied_at   timestamptz,
  expires_at   timestamptz,
  staff_id     uuid references staff_users(id) on delete set null
);
create index reward_redemptions_customer_idx on reward_redemptions(customer_id, issued_at desc);

create type coupon_kind as enum ('pct', 'amount', 'free_product');

create table coupons (
  id                    uuid primary key default gen_random_uuid(),
  code                  citext not null unique,
  name                  text,
  kind                  coupon_kind not null,
  value_bps             integer check (value_bps between 0 and 10000),
  value_cents           integer check (value_cents >= 0),
  product_id            uuid references products(id) on delete set null,   -- producto gratis o restringido
  min_subtotal_cents    integer not null default 0,
  starts_at             timestamptz,
  ends_at               timestamptz,
  max_uses              integer,
  max_uses_per_customer integer not null default 1,
  channels              price_channel[] not null default '{all}',
  segment               jsonb not null default '{}'::jsonb,   -- {"tiers":["vip"],"new_customers_only":true}
  is_active             boolean not null default true,
  uses_count            integer not null default 0,
  created_by            uuid references staff_users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint coupons_value_chk check (
    (kind = 'pct' and value_bps is not null) or
    (kind = 'amount' and value_cents is not null) or
    (kind = 'free_product' and product_id is not null)
  )
);
create trigger trg_coupons_updated before update on coupons for each row execute function set_updated_at();
create trigger trg_audit_coupons after insert or update or delete on coupons for each row execute function audit_row_change();

create table coupon_redemptions (
  id            uuid primary key default gen_random_uuid(),
  coupon_id     uuid not null references coupons(id) on delete cascade,
  customer_id   uuid references customers(id) on delete set null,
  order_id      uuid,                                      -- fk en 0005
  discount_cents integer not null,
  created_at    timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on coupon_redemptions(coupon_id);
create index coupon_redemptions_customer_idx on coupon_redemptions(customer_id);

-- Eventos de cliente (cumpleaños, hitos, inactividad, cambio de nivel)
create table customer_events (
  id           bigserial primary key,
  customer_id  uuid not null references customers(id) on delete cascade,
  kind         text not null,      -- birthday, anniversary, milestone_10, milestone_25, inactive_30, tier_up, returned
  payload      jsonb not null default '{}'::jsonb,
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);
create unique index customer_events_daily_idx on customer_events(customer_id, kind, ((created_at at time zone 'UTC')::date));
create index customer_events_open_idx on customer_events(created_at desc) where handled_at is null;

-- Resolver un cliente por QR/código/teléfono/email (usado por POS)
create or replace function find_customer(p_query text)
returns setof customers language sql stable as $$
  select * from customers c
  where c.deleted_at is null and c.merged_into_id is null
    and (c.qr_token = p_query or c.public_code = upper(p_query)
         or c.phone = p_query or c.email = p_query)
  limit 1
$$;
