-- 0014_audit_catalog.sql — Correcciones de la auditoría de Catálogo / Clientes / Fidelización.
-- Aditiva: solo `create or replace` de funciones definidas en 0004/0008/0010 (ninguna se redefine en
-- migraciones posteriores, así que el orden de aplicación en una base nueva —antes de 0020…0070— no cambia el resultado).
--
--  1. loyalty_post: los puntos devueltos por una reversa (cancelar canje) o movidos por una fusión ya
--     contaban en lifetime_points; volver a sumarlos inflaba el nivel del cliente.
--  2. normalize_mx_phone + register_customer + find_customer: "+52 664 123 4567", "52 664…" y
--     "6641234567" son el mismo teléfono (antes se creaban clientes duplicados).
--  3. create_promotion: rechaza promociones ya vencidas, solapadas en el mismo canal y arregla el
--     error crudo de constraint cuando valid_from venía nulo.
--  4. upsert_recipe: errores legibles para ingrediente repetido, inexistente/eliminado o sin cantidad.

-- ── 1. Ledger de puntos ────────────────────────────────────────────────────
-- lifetime_points = puntos ganados (earn, bonus) o concedidos manualmente (adjust). Las reversas
-- positivas (devolución de un canje) y los movimientos de fusión no son puntos nuevos.
create or replace function loyalty_post(p_customer_id uuid, p_kind loyalty_tx_kind, p_points integer, p_sale_id uuid default null, p_redemption_id uuid default null, p_note text default null)
returns integer language plpgsql as $$
declare
  v_balance integer;
begin
  if p_points = 0 then
    select points_balance into v_balance from customers where id = p_customer_id;
    return v_balance;
  end if;
  select points_balance into v_balance from customers where id = p_customer_id for update;
  if v_balance is null then raise exception 'Cliente % no existe', p_customer_id; end if;
  if v_balance + p_points < 0 then
    raise exception 'Puntos insuficientes: saldo %, requeridos %', v_balance, -p_points using errcode = 'check_violation';
  end if;
  v_balance := v_balance + p_points;
  update customers set points_balance = v_balance,
         lifetime_points = lifetime_points + case when p_kind in ('earn', 'bonus', 'adjust') then greatest(p_points, 0) else 0 end
   where id = p_customer_id;
  insert into loyalty_transactions(customer_id, kind, points, balance_after, sale_id, redemption_id, note, staff_id)
  values (p_customer_id, p_kind, p_points, v_balance, p_sale_id, p_redemption_id, p_note, current_staff_id());
  return v_balance;
end $$;

-- ── 2. Teléfonos ───────────────────────────────────────────────────────────
-- Forma canónica: números mexicanos a 10 dígitos (quita +52 / 52 / +521 / 01); otros con "+" en E.164.
-- Espejo de canonicalPhone() en @pdp/domain.
create or replace function normalize_mx_phone(p_raw text) returns text
language sql immutable as $$
  with s as (select regexp_replace(coalesce(p_raw, ''), '[^0-9+]', '', 'g') as kept),
       d as (select kept, regexp_replace(kept, '\D', '', 'g') as digits from s)
  select nullif(case
    when length(digits) = 10 then digits
    when length(digits) = 12 and digits like '52%' then substr(digits, 3)
    when length(digits) = 13 and digits like '521%' then substr(digits, 4)
    when length(digits) = 12 and digits like '01%' then substr(digits, 3)
    when kept like '+%' then '+' || digits
    else digits end, '')
  from d
$$;

create or replace function register_customer(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid;
  v_phone citext := normalize_mx_phone(p->>'phone');
  v_email citext := nullif(lower(btrim(coalesce(p->>'email',''))), '');
  v_existing customers%rowtype;
  prog loyalty_program%rowtype;
begin
  if nullif(btrim(coalesce(p->>'full_name','')), '') is null then raise exception 'El nombre es obligatorio' using errcode = 'check_violation'; end if;
  if v_phone is null and v_email is null then raise exception 'Se requiere teléfono o email' using errcode = 'check_violation'; end if;
  select * into v_existing from customers c where c.deleted_at is null and c.merged_into_id is null
    and ((v_phone is not null and (c.phone = v_phone or normalize_mx_phone(c.phone::text) = v_phone::text))
         or (v_email is not null and c.email = v_email))
  order by c.created_at limit 1;
  if v_existing.id is not null then
    update customers set
      email = coalesce(email, v_email), phone = coalesce(phone, v_phone),
      birthday = coalesce(birthday, nullif(p->>'birthday','')::date),
      marketing_consent = marketing_consent or coalesce((p->>'marketing_consent')::boolean, false)
    where id = v_existing.id;
    return jsonb_build_object('customer_id', v_existing.id, 'public_code', v_existing.public_code, 'qr_token', v_existing.qr_token, 'created', false);
  end if;
  insert into customers(full_name, phone, email, birthday, source, marketing_consent, notes)
  values (btrim(p->>'full_name'), v_phone, v_email, nullif(p->>'birthday','')::date, coalesce(p->>'source','pos'), coalesce((p->>'marketing_consent')::boolean, false), p->>'notes')
  returning id into v_id;
  select * into prog from loyalty_program where id = 1;
  if prog.is_active and prog.signup_bonus_points > 0 then
    perform loyalty_post(v_id, 'bonus', prog.signup_bonus_points, null, null, 'Bono de bienvenida');
  end if;
  perform recompute_customer_tier(v_id);
  perform emit_event('CUSTOMER_REGISTERED', 'customer', v_id::text, jsonb_build_object('source', p->>'source'));
  return (select jsonb_build_object('customer_id', id, 'public_code', public_code, 'qr_token', qr_token, 'created', true) from customers where id = v_id);
end $$;

-- Resolver un cliente por QR/código/teléfono/email (POS, Instagram). Teléfono comparado en forma canónica.
create or replace function find_customer(p_query text)
returns setof customers language sql stable as $$
  select * from customers c
  where c.deleted_at is null and c.merged_into_id is null
    and (c.qr_token = p_query or c.public_code = upper(btrim(p_query))
         or c.phone = btrim(p_query) or c.email = btrim(p_query)
         or (normalize_mx_phone(p_query) is not null and length(normalize_mx_phone(p_query)) >= 10
             and normalize_mx_phone(c.phone::text) = normalize_mx_phone(p_query)))
  order by (c.qr_token = p_query) desc, (c.public_code = upper(btrim(p_query))) desc, c.created_at
  limit 1
$$;

-- ── 3. Promociones ─────────────────────────────────────────────────────────
create or replace function create_promotion(
  p_product_id uuid,
  p_channel price_channel,
  p_price_cents integer,
  p_valid_from timestamptz,
  p_valid_to timestamptz,
  p_label text default null
) returns uuid language plpgsql as $$
declare
  v_id uuid;
  v_regular integer;
  v_from timestamptz := coalesce(p_valid_from, now());
  v_overlap product_prices%rowtype;
begin
  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'El precio debe ser mayor o igual a cero';
  end if;
  if p_valid_to is not null and p_valid_to <= v_from then
    raise exception 'La fecha de fin debe ser posterior al inicio';
  end if;
  if p_valid_to is not null and p_valid_to <= now() then
    raise exception 'La promoción ya habría terminado: elige una fecha de fin futura';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  -- Una sola promoción vigente por canal y periodo: si se solapa con otra del mismo canal, hay que terminarla primero.
  -- (Las promociones ya cerradas —valid_to ≤ ahora— no cuentan, aunque el nuevo inicio venga unos ms antes.)
  select * into v_overlap from product_prices
   where product_id = p_product_id and kind = 'promo' and channel = p_channel
     and valid_from < coalesce(p_valid_to, 'infinity'::timestamptz)
     and coalesce(valid_to, 'infinity'::timestamptz) > greatest(v_from, now())
   order by valid_from limit 1;
  if v_overlap.id is not null then
    raise exception 'Ya existe la promoción "%" en ese canal para ese periodo (desde %). Termínala antes de crear otra.',
      coalesce(v_overlap.label, 'sin nombre'), to_char(v_overlap.valid_from at time zone (select timezone from business_settings where id = 1), 'YYYY-MM-DD HH24:MI')
      using errcode = 'check_violation';
  end if;
  select price_cents into v_regular from product_prices
   where product_id = p_product_id and kind = 'regular' and (channel = p_channel or channel = 'all')
     and valid_from <= greatest(v_from, now()) and (valid_to is null or valid_to > greatest(v_from, now()))
   order by case when channel = p_channel then 0 else 1 end, valid_from desc limit 1;
  if v_regular is not null and p_price_cents >= v_regular then
    raise exception 'La promoción (%) debe ser menor al precio regular vigente (%)', p_price_cents, v_regular;
  end if;
  insert into product_prices(product_id, channel, kind, price_cents, valid_from, valid_to, label, created_by)
  values (p_product_id, p_channel, 'promo', p_price_cents, v_from, p_valid_to, nullif(trim(p_label), ''), current_staff_id())
  returning id into v_id;
  perform emit_event('PROMO_CREATED', 'product', p_product_id::text,
    jsonb_build_object('price_id', v_id, 'channel', p_channel, 'price_cents', p_price_cents, 'valid_from', v_from, 'valid_to', p_valid_to));
  return v_id;
end $$;

-- ── 4. Recetas ─────────────────────────────────────────────────────────────
create or replace function upsert_recipe(
  p_product_id uuid,
  p_yield_qty numeric,
  p_yield_label text,
  p_labor_cents integer,
  p_overhead_cents integer,
  p_notes text,
  p_items jsonb
) returns uuid language plpgsql as $$
declare
  v_recipe_id uuid;
  v_item jsonb;
  v_i integer := 0;
  v_ing uuid;
  v_qty numeric;
  v_name text;
begin
  if p_yield_qty is null or p_yield_qty <= 0 then
    raise exception 'El rendimiento debe ser mayor a cero';
  end if;
  if p_labor_cents is not null and p_labor_cents < 0 then
    raise exception 'La mano de obra no puede ser negativa';
  end if;
  if p_overhead_cents is not null and p_overhead_cents < 0 then
    raise exception 'Los indirectos no pueden ser negativos';
  end if;
  if not exists (select 1 from products where id = p_product_id and deleted_at is null) then
    raise exception 'Producto no encontrado';
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'Las líneas de la receta no son válidas';
  end if;
  insert into recipes(product_id, yield_qty, yield_label, labor_cents, overhead_cents, notes)
  values (p_product_id, p_yield_qty, nullif(trim(p_yield_label), ''), coalesce(p_labor_cents, 0), coalesce(p_overhead_cents, 0), nullif(trim(p_notes), ''))
  on conflict (product_id) do update
    set yield_qty = excluded.yield_qty,
        yield_label = excluded.yield_label,
        labor_cents = excluded.labor_cents,
        overhead_cents = excluded.overhead_cents,
        notes = excluded.notes,
        version = recipes.version + 1
  returning id into v_recipe_id;
  delete from recipe_items where recipe_id = v_recipe_id;
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    begin
      v_ing := nullif(v_item->>'ingredient_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Ingrediente inválido en la receta';
    end;
    v_qty := nullif(v_item->>'qty', '')::numeric;
    if v_ing is null then raise exception 'Cada línea de la receta necesita un ingrediente'; end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'La cantidad de cada ingrediente debe ser mayor a cero';
    end if;
    select name into v_name from ingredients where id = v_ing and deleted_at is null;
    if v_name is null then
      raise exception 'Un ingrediente de la receta ya no existe o fue eliminado';
    end if;
    if exists (select 1 from recipe_items where recipe_id = v_recipe_id and ingredient_id = v_ing) then
      raise exception 'El ingrediente "%" aparece dos veces en la receta; combina las líneas', v_name using errcode = 'check_violation';
    end if;
    insert into recipe_items(recipe_id, ingredient_id, qty, note, sort_order)
    values (v_recipe_id, v_ing, v_qty, nullif(trim(v_item->>'note'), ''), v_i);
    v_i := v_i + 1;
  end loop;
  perform emit_event('RECIPE_UPDATED', 'product', p_product_id::text,
    jsonb_build_object('recipe_id', v_recipe_id, 'items', v_i, 'cost_per_piece_cents', product_cost_cents(p_product_id)));
  return v_recipe_id;
end $$;
