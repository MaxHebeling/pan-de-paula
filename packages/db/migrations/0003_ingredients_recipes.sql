-- 0003_ingredients_recipes.sql — Proveedores, ingredientes, historial de precios de insumo, recetas y costeo.
-- Unidades base: g (gramos), ml (mililitros), pz (piezas). Compras en kg/l se convierten a base.

create type base_unit as enum ('g', 'ml', 'pz');

create table suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  contact     text,
  phone       text,
  email       citext,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_suppliers_updated before update on suppliers for each row execute function set_updated_at();

create table ingredients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  brand         text,
  supplier_id   uuid references suppliers(id) on delete set null,
  base_unit     base_unit not null,
  stock_qty     numeric(14,3) not null default 0,     -- en unidad base
  min_stock_qty numeric(14,3) not null default 0,
  is_available  boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index ingredients_name_idx on ingredients(lower(name), coalesce(lower(brand), '')) where deleted_at is null;
create trigger trg_ingredients_updated before update on ingredients for each row execute function set_updated_at();
create trigger trg_audit_ingredients after insert or update or delete on ingredients for each row execute function audit_row_change();

-- Historial de precios de compra. unit_cost = precio / contenido en unidad base.
create table ingredient_prices (
  id              uuid primary key default gen_random_uuid(),
  ingredient_id   uuid not null references ingredients(id) on delete cascade,
  supplier_id     uuid references suppliers(id) on delete set null,
  package_label   text,                               -- ej. "Caja 1.808 kg"
  package_qty     numeric(14,3) not null check (package_qty > 0),   -- contenido en unidad base (g/ml/pz)
  price_cents     integer not null check (price_cents >= 0),
  unit_cost       numeric(18,8) generated always as (price_cents::numeric / 100 / package_qty) stored, -- MXN por unidad base
  valid_from      timestamptz not null default now(),
  source          text not null default 'manual',    -- manual | import | purchase
  created_by      uuid references staff_users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index ingredient_prices_lookup_idx on ingredient_prices(ingredient_id, valid_from desc);
create trigger trg_audit_ingredient_prices after insert or update or delete on ingredient_prices for each row execute function audit_row_change();

-- Costo unitario vigente en una fecha (MXN por unidad base)
create or replace function ingredient_unit_cost(p_ingredient_id uuid, p_at timestamptz default now())
returns numeric language sql stable as $$
  select unit_cost from ingredient_prices
  where ingredient_id = p_ingredient_id and valid_from <= p_at
  order by valid_from desc limit 1
$$;

create table recipes (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null unique references products(id) on delete cascade,
  yield_qty     numeric(12,3) not null default 1 check (yield_qty > 0),   -- piezas que rinde la receta
  yield_label   text,
  labor_cents   integer not null default 0 check (labor_cents >= 0),       -- mano de obra por lote (opcional)
  overhead_cents integer not null default 0 check (overhead_cents >= 0),   -- gastos indirectos por lote (opcional)
  notes         text,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_recipes_updated before update on recipes for each row execute function set_updated_at();
create trigger trg_audit_recipes after insert or update or delete on recipes for each row execute function audit_row_change();

create table recipe_items (
  id             uuid primary key default gen_random_uuid(),
  recipe_id      uuid not null references recipes(id) on delete cascade,
  ingredient_id  uuid not null references ingredients(id) on delete restrict,
  qty            numeric(14,3) not null check (qty > 0),    -- en unidad base del ingrediente
  note           text,
  sort_order     integer not null default 0,
  unique (recipe_id, ingredient_id)
);
create index recipe_items_recipe_idx on recipe_items(recipe_id);
create trigger trg_audit_recipe_items after insert or update or delete on recipe_items for each row execute function audit_row_change();

-- Costo por pieza en centavos (redondeo half-up) en una fecha dada. NULL si no hay receta.
create or replace function product_cost_cents(p_product_id uuid, p_at timestamptz default now())
returns integer language plpgsql stable as $$
declare
  v_yield numeric;
  v_ingredients numeric;
  v_labor integer;
  v_overhead integer;
begin
  select r.yield_qty, r.labor_cents, r.overhead_cents,
         coalesce((select sum(ri.qty * coalesce(ingredient_unit_cost(ri.ingredient_id, p_at), 0))
                   from recipe_items ri where ri.recipe_id = r.id), 0)
    into v_yield, v_labor, v_overhead, v_ingredients
  from recipes r where r.product_id = p_product_id;
  if v_yield is null then return null; end if;
  return round(((v_ingredients * 100) + v_labor + v_overhead) / v_yield)::integer;
end $$;

-- Vista de costeo (desglose por receta)
create or replace view recipe_costing as
select r.id as recipe_id, r.product_id, p.name as product_name, r.yield_qty,
       coalesce(sum(ri.qty * coalesce(ingredient_unit_cost(ri.ingredient_id), 0)), 0)::numeric(14,4) as ingredients_cost,
       r.labor_cents, r.overhead_cents,
       product_cost_cents(r.product_id) as cost_per_piece_cents,
       current_price_cents(r.product_id, 'pos') as pos_price_cents,
       case when current_price_cents(r.product_id, 'pos') > 0
            then round((current_price_cents(r.product_id, 'pos') - coalesce(product_cost_cents(r.product_id),0))::numeric
                       / current_price_cents(r.product_id, 'pos') * 10000)::integer end as margin_bps,
       count(ri.id) as ingredient_count,
       bool_or(ingredient_unit_cost(ri.ingredient_id) is null) as has_missing_prices
from recipes r
join products p on p.id = r.product_id
left join recipe_items ri on ri.recipe_id = r.id
group by r.id, p.name;
