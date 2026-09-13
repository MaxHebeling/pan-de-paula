-- 0011_costing_formulas.sql — Parámetros configurables de costeo (merma, mano de obra por hora, indirectos como % de insumos),
-- precio sugerido con redondeo y desglose de fórmulas para la "hoja de costos".
-- Aditiva. Con los valores por defecto (sin overrides) product_cost_cents devuelve exactamente lo mismo que antes.

-- ── Parámetros globales (singleton) ──────────────────────────────────────────
create table costing_settings (
  id                         smallint primary key default 1 check (id = 1),
  default_target_margin_bps  integer not null default 6000 check (default_target_margin_bps between 0 and 9900),
  price_rounding_cents       integer not null default 100 check (price_rounding_cents in (50, 100, 500, 1000)),
  default_waste_bps          integer not null default 0 check (default_waste_bps between 0 and 10000),
  labor_mode                 text not null default 'per_batch' check (labor_mode in ('per_batch', 'per_hour')),
  labor_rate_cents_per_hour  integer not null default 0 check (labor_rate_cents_per_hour >= 0),
  overhead_mode              text not null default 'fixed' check (overhead_mode in ('fixed', 'pct_of_ingredients')),
  overhead_pct_bps           integer not null default 0 check (overhead_pct_bps between 0 and 100000),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create trigger trg_costing_settings_updated before update on costing_settings for each row execute function set_updated_at();
create trigger trg_audit_costing_settings after update on costing_settings for each row execute function audit_row_change();
insert into costing_settings (id) values (1);
alter table costing_settings enable row level security;
create policy pdp_app_all on costing_settings for all to pdp_app using (true) with check (true);

-- ── Overrides por receta ─────────────────────────────────────────────────────
alter table recipes
  add column target_margin_bps integer check (target_margin_bps between 0 and 9900),  -- null = usa el default global
  add column waste_bps         integer check (waste_bps between 0 and 10000),          -- null = usa el default global
  add column labor_minutes     numeric(10,2) check (labor_minutes >= 0);               -- solo aplica con labor_mode = 'per_hour'

-- ── Términos de la fórmula de una receta a partir del subtotal de insumos ────
-- Una sola fuente de verdad para product_cost_cents, product_cost_impact, la vista y el desglose.
--   MO         = per_batch → labor_cents · per_hour → labor_minutes ÷ 60 × tarifa (si no hay minutos, labor_cents)
--   Indirectos = fixed → overhead_cents · pct_of_ingredients → insumos × pct
--   Costo/pieza = (insumos + MO + indirectos) ÷ rendimiento × (1 + merma)
create or replace function recipe_cost_terms(p_recipe_id uuid, p_ingredients_mxn numeric)
returns table (
  yield_qty numeric,
  labor_cents numeric,
  overhead_cents numeric,
  waste_bps integer,
  target_margin_bps integer,
  batch_cents numeric,
  cost_per_piece_cents integer
) language sql stable as $$
  with s as (select * from costing_settings where id = 1),
  r as (select * from recipes where id = p_recipe_id),
  t as (
    select r.yield_qty,
           case when s.labor_mode = 'per_hour' and r.labor_minutes is not null
                then r.labor_minutes / 60 * s.labor_rate_cents_per_hour
                else r.labor_cents::numeric end as labor_cents,
           case when s.overhead_mode = 'pct_of_ingredients'
                then coalesce(p_ingredients_mxn, 0) * 100 * s.overhead_pct_bps / 10000
                else r.overhead_cents::numeric end as overhead_cents,
           coalesce(r.waste_bps, s.default_waste_bps) as waste_bps,
           coalesce(r.target_margin_bps, s.default_target_margin_bps) as target_margin_bps
    from r cross join s
  )
  select t.yield_qty, t.labor_cents, t.overhead_cents, t.waste_bps, t.target_margin_bps,
         (coalesce(p_ingredients_mxn, 0) * 100 + t.labor_cents + t.overhead_cents) as batch_cents,
         round((coalesce(p_ingredients_mxn, 0) * 100 + t.labor_cents + t.overhead_cents) / t.yield_qty
               * (1 + t.waste_bps / 10000.0))::integer as cost_per_piece_cents
  from t
$$;

-- Subtotal de insumos (MXN) de una receta a una fecha.
create or replace function recipe_ingredients_mxn(p_recipe_id uuid, p_at timestamptz default now())
returns numeric language sql stable as $$
  select coalesce(sum(ri.qty * coalesce(ingredient_unit_cost(ri.ingredient_id, p_at), 0)), 0)
  from recipe_items ri where ri.recipe_id = p_recipe_id
$$;

-- Costo por pieza en centavos. Misma firma que antes; NULL si no hay receta.
create or replace function product_cost_cents(p_product_id uuid, p_at timestamptz default now())
returns integer language sql stable as $$
  select t.cost_per_piece_cents
  from recipes r
  cross join lateral recipe_cost_terms(r.id, recipe_ingredients_mxn(r.id, p_at)) t
  where r.product_id = p_product_id
$$;

-- Precio sugerido: costo ÷ (1 − margen objetivo), redondeado HACIA ARRIBA al múltiplo configurado.
-- p_margin_bps null → override de la receta o default global. NULL si no hay receta.
create or replace function suggested_price_cents(p_product_id uuid, p_margin_bps integer default null)
returns integer language sql stable as $$
  select case when t.cost_per_piece_cents is null or m.bps >= 10000 then null
              else (ceil((t.cost_per_piece_cents::numeric / (1 - m.bps / 10000.0)) / s.price_rounding_cents) * s.price_rounding_cents)::integer end
  from recipes r
  cross join costing_settings s
  cross join lateral recipe_cost_terms(r.id, recipe_ingredients_mxn(r.id, now())) t
  cross join lateral (select coalesce(p_margin_bps, t.target_margin_bps) as bps) m
  where r.product_id = p_product_id and s.id = 1
$$;

-- Impacto de un nuevo costo unitario de insumo (misma firma), ahora con la fórmula completa.
create or replace function product_cost_impact(p_ingredient_id uuid, p_new_unit_cost numeric)
returns table (
  product_id uuid,
  product_name text,
  current_cost_cents integer,
  new_cost_cents integer
) language sql stable as $$
  with affected as (
    select r.id as recipe_id, r.product_id, p.name
    from recipes r
    join products p on p.id = r.product_id and p.deleted_at is null
    where exists (select 1 from recipe_items ri where ri.recipe_id = r.id and ri.ingredient_id = p_ingredient_id)
  ),
  costs as (
    select a.recipe_id, a.product_id, a.name,
           coalesce(sum(ri.qty * coalesce(ingredient_unit_cost(ri.ingredient_id), 0)), 0) as cur_ing,
           coalesce(sum(ri.qty * case when ri.ingredient_id = p_ingredient_id then p_new_unit_cost
                                      else coalesce(ingredient_unit_cost(ri.ingredient_id), 0) end), 0) as new_ing
    from affected a
    join recipe_items ri on ri.recipe_id = a.recipe_id
    group by a.recipe_id, a.product_id, a.name
  )
  select c.product_id, c.name, cur.cost_per_piece_cents, nw.cost_per_piece_cents
  from costs c
  cross join lateral recipe_cost_terms(c.recipe_id, c.cur_ing) cur
  cross join lateral recipe_cost_terms(c.recipe_id, c.new_ing) nw
  order by c.name
$$;

-- Desglose completo de la fórmula (todos los términos con valores) para mostrarla "como hoja de cálculo".
create or replace function recipe_formula_breakdown(p_product_id uuid)
returns jsonb language sql stable as $$
  with p as (select id, name from products where id = p_product_id and deleted_at is null),
  s as (select * from costing_settings where id = 1),
  r as (select * from recipes where product_id = p_product_id),
  lines as (
    select ri.sort_order, jsonb_build_object(
             'ingredient_id', ri.ingredient_id,
             'name', i.name || coalesce(' (' || i.brand || ')', ''),
             'base_unit', i.base_unit,
             'qty', ri.qty,
             'unit_cost', ingredient_unit_cost(ri.ingredient_id),
             'cost_mxn', case when ingredient_unit_cost(ri.ingredient_id) is null then null
                              else ri.qty * ingredient_unit_cost(ri.ingredient_id) end) as line,
           ingredient_unit_cost(ri.ingredient_id) is null as missing
    from r join recipe_items ri on ri.recipe_id = r.id
    join ingredients i on i.id = ri.ingredient_id
  ),
  ing as (select recipe_ingredients_mxn(r.id, now()) as mxn from r),
  t as (select t.* from r cross join lateral recipe_cost_terms(r.id, (select mxn from ing)) t),
  prices as (select current_price_cents(p_product_id, 'pos') as pos, current_price_cents(p_product_id, 'web') as web)
  select jsonb_build_object(
    'product_id', p.id,
    'product_name', p.name,
    'has_recipe', r.id is not null,
    'recipe_id', r.id,
    'version', r.version,
    'settings', jsonb_build_object(
      'default_target_margin_bps', s.default_target_margin_bps,
      'price_rounding_cents', s.price_rounding_cents,
      'default_waste_bps', s.default_waste_bps,
      'labor_mode', s.labor_mode,
      'labor_rate_cents_per_hour', s.labor_rate_cents_per_hour,
      'overhead_mode', s.overhead_mode,
      'overhead_pct_bps', s.overhead_pct_bps),
    'lines', coalesce((select jsonb_agg(line order by sort_order) from lines), '[]'::jsonb),
    'has_missing_prices', coalesce((select bool_or(missing) from lines), false),
    'ingredients_mxn', coalesce((select mxn from ing), 0),
    'labor', jsonb_build_object(
      'mode', s.labor_mode,
      'per_batch_cents', r.labor_cents,
      'minutes', r.labor_minutes,
      'rate_cents_per_hour', s.labor_rate_cents_per_hour,
      'cents', t.labor_cents),
    'overhead', jsonb_build_object(
      'mode', s.overhead_mode,
      'fixed_cents', r.overhead_cents,
      'pct_bps', s.overhead_pct_bps,
      'cents', t.overhead_cents),
    'yield_qty', r.yield_qty,
    'yield_label', r.yield_label,
    'waste_bps', t.waste_bps,
    'waste_source', case when r.waste_bps is null then 'default' else 'recipe' end,
    'recipe_waste_bps', r.waste_bps,
    'batch_cents', t.batch_cents,
    'cost_per_piece_cents', t.cost_per_piece_cents,
    'pos_price_cents', prices.pos,
    'web_price_cents', prices.web,
    'pos_margin_bps', case when prices.pos > 0 and t.cost_per_piece_cents is not null
                           then round((prices.pos - t.cost_per_piece_cents)::numeric / prices.pos * 10000)::integer end,
    'web_margin_bps', case when prices.web > 0 and t.cost_per_piece_cents is not null
                           then round((prices.web - t.cost_per_piece_cents)::numeric / prices.web * 10000)::integer end,
    'target_margin_bps', coalesce(t.target_margin_bps, s.default_target_margin_bps),
    'target_source', case when r.target_margin_bps is null then 'default' else 'recipe' end,
    'recipe_target_margin_bps', r.target_margin_bps,
    'suggested_raw_cents', case when t.cost_per_piece_cents is null or t.target_margin_bps >= 10000 then null
                                else round(t.cost_per_piece_cents::numeric / (1 - t.target_margin_bps / 10000.0), 4) end,
    'suggested_price_cents', suggested_price_cents(p_product_id)
  )
  from p cross join s left join r on true left join t on true cross join prices
$$;

-- Cambia parámetros de la receta celda por celda (hoja de costos). Crea la receta si no existe.
-- p_patch: cualquier subconjunto de {yield_qty, yield_label, labor_cents, overhead_cents, labor_minutes, waste_bps, target_margin_bps, notes}.
-- Una clave presente con valor null limpia el override (vuelve al default global). Devuelve el desglose actualizado.
create or replace function update_recipe_params(p_product_id uuid, p_patch jsonb)
returns jsonb language plpgsql as $$
declare
  v_recipe_id uuid;
  v_yield numeric;
  v_labor integer;
  v_overhead integer;
  v_minutes numeric;
  v_waste integer;
  v_margin integer;
begin
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Parámetros inválidos';
  end if;
  insert into recipes(product_id) values (p_product_id)
  on conflict (product_id) do nothing;
  select id into v_recipe_id from recipes where product_id = p_product_id;

  if p_patch ? 'yield_qty' then
    v_yield := (p_patch->>'yield_qty')::numeric;
    if v_yield is null or v_yield <= 0 then raise exception 'El rendimiento debe ser mayor a cero'; end if;
    update recipes set yield_qty = v_yield where id = v_recipe_id;
  end if;
  if p_patch ? 'yield_label' then
    update recipes set yield_label = nullif(trim(p_patch->>'yield_label'), '') where id = v_recipe_id;
  end if;
  if p_patch ? 'labor_cents' then
    v_labor := (p_patch->>'labor_cents')::integer;
    if v_labor is null or v_labor < 0 then raise exception 'La mano de obra no puede ser negativa'; end if;
    update recipes set labor_cents = v_labor where id = v_recipe_id;
  end if;
  if p_patch ? 'overhead_cents' then
    v_overhead := (p_patch->>'overhead_cents')::integer;
    if v_overhead is null or v_overhead < 0 then raise exception 'Los indirectos no pueden ser negativos'; end if;
    update recipes set overhead_cents = v_overhead where id = v_recipe_id;
  end if;
  if p_patch ? 'labor_minutes' then
    v_minutes := (p_patch->>'labor_minutes')::numeric;
    if v_minutes is not null and v_minutes < 0 then raise exception 'Los minutos de mano de obra no pueden ser negativos'; end if;
    update recipes set labor_minutes = v_minutes where id = v_recipe_id;
  end if;
  if p_patch ? 'waste_bps' then
    v_waste := (p_patch->>'waste_bps')::integer;
    if v_waste is not null and (v_waste < 0 or v_waste > 10000) then raise exception 'La merma debe estar entre 0%% y 100%%'; end if;
    update recipes set waste_bps = v_waste where id = v_recipe_id;
  end if;
  if p_patch ? 'target_margin_bps' then
    v_margin := (p_patch->>'target_margin_bps')::integer;
    if v_margin is not null and (v_margin < 0 or v_margin > 9900) then raise exception 'El margen objetivo debe estar entre 0%% y 99%%'; end if;
    update recipes set target_margin_bps = v_margin where id = v_recipe_id;
  end if;
  if p_patch ? 'notes' then
    update recipes set notes = nullif(trim(p_patch->>'notes'), '') where id = v_recipe_id;
  end if;
  update recipes set version = version + 1 where id = v_recipe_id;
  perform emit_event('RECIPE_UPDATED', 'product', p_product_id::text,
    jsonb_build_object('recipe_id', v_recipe_id, 'patch', p_patch, 'cost_per_piece_cents', product_cost_cents(p_product_id)));
  return recipe_formula_breakdown(p_product_id);
end $$;

-- Receta completa (cabecera + líneas + overrides) en una transacción. upsert_recipe (7 parámetros) se conserva para compatibilidad.
create or replace function upsert_recipe_v2(
  p_product_id uuid,
  p_yield_qty numeric,
  p_yield_label text,
  p_labor_cents integer,
  p_overhead_cents integer,
  p_notes text,
  p_items jsonb,
  p_waste_bps integer default null,
  p_target_margin_bps integer default null,
  p_labor_minutes numeric default null
) returns uuid language plpgsql as $$
declare
  v_recipe_id uuid;
begin
  if p_waste_bps is not null and (p_waste_bps < 0 or p_waste_bps > 10000) then
    raise exception 'La merma debe estar entre 0%% y 100%%';
  end if;
  if p_target_margin_bps is not null and (p_target_margin_bps < 0 or p_target_margin_bps > 9900) then
    raise exception 'El margen objetivo debe estar entre 0%% y 99%%';
  end if;
  if p_labor_minutes is not null and p_labor_minutes < 0 then
    raise exception 'Los minutos de mano de obra no pueden ser negativos';
  end if;
  v_recipe_id := upsert_recipe(p_product_id, p_yield_qty, p_yield_label, p_labor_cents, p_overhead_cents, p_notes, p_items);
  update recipes
     set waste_bps = p_waste_bps,
         target_margin_bps = p_target_margin_bps,
         labor_minutes = p_labor_minutes
   where id = v_recipe_id;
  return v_recipe_id;
end $$;

-- Vista de costeo: se conservan las columnas existentes (mismo orden) y se añaden las nuevas al final.
create or replace view recipe_costing as
select r.id as recipe_id, r.product_id, p.name as product_name, r.yield_qty,
       ing.mxn::numeric(14,4) as ingredients_cost,
       r.labor_cents, r.overhead_cents,
       t.cost_per_piece_cents,
       pr.pos as pos_price_cents,
       case when pr.pos > 0
            then round((pr.pos - coalesce(t.cost_per_piece_cents, 0))::numeric / pr.pos * 10000)::integer end as margin_bps,
       (select count(*) from recipe_items ri where ri.recipe_id = r.id) as ingredient_count,
       coalesce((select bool_or(ingredient_unit_cost(ri.ingredient_id) is null) from recipe_items ri where ri.recipe_id = r.id), false) as has_missing_prices,
       -- nuevas
       pr.web as web_price_cents,
       case when pr.web > 0
            then round((pr.web - coalesce(t.cost_per_piece_cents, 0))::numeric / pr.web * 10000)::integer end as web_margin_bps,
       t.labor_cents as labor_effective_cents,
       t.overhead_cents as overhead_effective_cents,
       t.waste_bps,
       t.target_margin_bps,
       r.waste_bps as recipe_waste_bps,
       r.target_margin_bps as recipe_target_margin_bps,
       r.labor_minutes,
       suggested_price_cents(r.product_id) as suggested_price_cents
from recipes r
join products p on p.id = r.product_id
cross join lateral (select recipe_ingredients_mxn(r.id, now()) as mxn) ing
cross join lateral recipe_cost_terms(r.id, ing.mxn) t
cross join lateral (select current_price_cents(r.product_id, 'pos') as pos, current_price_cents(r.product_id, 'web') as web) pr;
