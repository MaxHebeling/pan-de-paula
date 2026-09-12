-- 0006_inventory_production.sql — Inventario por movimientos, niveles, producción por lotes, mermas, conteos, insumos.

create type movement_type as enum (
  'INITIAL', 'PRODUCTION', 'SALE', 'WASTE', 'CORRECTION', 'RETURN', 'GIFT', 'INTERNAL_USE', 'TRANSFER', 'VOID'
);

create table inventory_movements (
  id           bigserial primary key,
  product_id   uuid not null references products(id) on delete restrict,
  type         movement_type not null,
  qty          numeric(12,3) not null check (qty <> 0),     -- signo: + entra, - sale
  ref_type     text,                                        -- sale | production_batch | waste_record | stock_count | order | return
  ref_id       text,
  reason       text,
  note         text,
  staff_id     uuid references staff_users(id) on delete set null,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index inventory_movements_product_idx on inventory_movements(product_id, occurred_at desc);
create index inventory_movements_ref_idx on inventory_movements(ref_type, ref_id);
create index inventory_movements_type_idx on inventory_movements(type, occurred_at desc);

-- Nivel actual (mantenido por trigger; siempre reconstruible desde movimientos)
create table inventory_levels (
  product_id  uuid primary key references products(id) on delete cascade,
  on_hand     numeric(12,3) not null default 0,
  updated_at  timestamptz not null default now()
);

create or replace function apply_inventory_movement() returns trigger
language plpgsql as $$
begin
  insert into inventory_levels(product_id, on_hand, updated_at)
  values (new.product_id, new.qty, now())
  on conflict (product_id) do update
    set on_hand = inventory_levels.on_hand + excluded.on_hand, updated_at = now();
  return new;
end $$;
create trigger trg_inventory_movements_apply after insert on inventory_movements
for each row execute function apply_inventory_movement();

-- Movimientos son append-only: prohibido UPDATE/DELETE
create or replace function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'La tabla % es de solo inserción (append-only)', tg_table_name;
end $$;
create trigger trg_inventory_movements_immutable before update or delete on inventory_movements
for each row execute function forbid_change();
create trigger trg_loyalty_tx_immutable before update or delete on loyalty_transactions
for each row execute function forbid_change();
create trigger trg_domain_events_immutable before update or delete on domain_events
for each row execute function forbid_change();

-- Reconstrucción de niveles (para conciliar/reparar)
create or replace function rebuild_inventory_levels() returns void language sql as $$
  insert into inventory_levels(product_id, on_hand, updated_at)
  select product_id, sum(qty), now() from inventory_movements group by product_id
  on conflict (product_id) do update set on_hand = excluded.on_hand, updated_at = now();
$$;

-- Producción
create table production_batches (
  id           uuid primary key default gen_random_uuid(),
  lot_code     text not null default ('L' || to_char(now(), 'YYMMDD') || '-' || upper(substr(encode(gen_random_bytes(3),'hex'),1,4))),
  product_id   uuid not null references products(id) on delete restrict,
  qty          numeric(12,3) not null check (qty > 0),
  produced_at  timestamptz not null default now(),
  staff_id     uuid references staff_users(id) on delete set null,
  notes        text,
  ingredients_consumed boolean not null default false,
  cost_cents_snapshot integer,
  created_at   timestamptz not null default now()
);
create index production_batches_date_idx on production_batches(produced_at desc);
create index production_batches_product_idx on production_batches(product_id, produced_at desc);

-- Mermas
create table waste_records (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete restrict,
  qty         numeric(12,3) not null check (qty > 0),
  reason      text not null check (reason in ('burnt','broken','expired','tasting','gift','courtesy','internal_use','error','difference','other')),
  note        text,
  staff_id    uuid references staff_users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  cost_cents_snapshot integer,
  created_at  timestamptz not null default now()
);
create index waste_records_date_idx on waste_records(occurred_at desc);

-- Conteos físicos / conciliación
create table stock_counts (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  closed_at   timestamptz,
  status      text not null default 'open' check (status in ('open','applied','discarded')),
  staff_id    uuid references staff_users(id) on delete set null,
  notes       text
);
create table stock_count_items (
  id             uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references stock_counts(id) on delete cascade,
  product_id     uuid not null references products(id) on delete restrict,
  expected_qty   numeric(12,3) not null,
  counted_qty    numeric(12,3) not null,
  difference_qty numeric(12,3) generated always as (counted_qty - expected_qty) stored,
  note           text,
  unique (stock_count_id, product_id)
);

-- Movimientos de insumos
create type ingredient_movement_type as enum ('PURCHASE', 'CONSUMPTION', 'WASTE', 'CORRECTION', 'INITIAL');
create table ingredient_movements (
  id             bigserial primary key,
  ingredient_id  uuid not null references ingredients(id) on delete restrict,
  type           ingredient_movement_type not null,
  qty            numeric(14,3) not null check (qty <> 0),
  ref_type       text,
  ref_id         text,
  note           text,
  staff_id       uuid references staff_users(id) on delete set null,
  occurred_at    timestamptz not null default now()
);
create index ingredient_movements_ing_idx on ingredient_movements(ingredient_id, occurred_at desc);
create or replace function apply_ingredient_movement() returns trigger language plpgsql as $$
begin
  update ingredients set stock_qty = stock_qty + new.qty where id = new.ingredient_id;
  return new;
end $$;
create trigger trg_ingredient_movements_apply after insert on ingredient_movements
for each row execute function apply_ingredient_movement();
create trigger trg_ingredient_movements_immutable before update or delete on ingredient_movements
for each row execute function forbid_change();

-- Vista de stock con alertas
create or replace view stock_status as
select p.id as product_id, p.name, p.category_id, p.track_stock,
       coalesce(l.on_hand, 0) as on_hand,
       bs.low_stock_threshold,
       case when coalesce(l.on_hand,0) <= 0 then 'out'
            when coalesce(l.on_hand,0) <= bs.low_stock_threshold then 'low'
            else 'ok' end as level,
       l.updated_at
from products p
cross join business_settings bs
left join inventory_levels l on l.product_id = p.id
where p.deleted_at is null and p.is_active;
