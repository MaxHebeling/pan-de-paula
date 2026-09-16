-- 0044_phone_international.sql — Teléfonos internacionales: buscar y deduplicar un número extranjero
-- escrito con o sin "+". Rango reservado 0040–0049 (clientes/fidelización).
--
-- Aditiva y sin tocar un solo dato: `customers.phone` NO se migra. La regla de almacenamiento sigue
-- siendo la de siempre para México —10 dígitos pelados, que es lo que hay hoy en producción— y los
-- teléfonos de otros países, que hasta ahora no se podían capturar, entran en E.164 ("+16195550100").
-- Espejo en TypeScript: `parsePhone()` / `splitStoredPhone()` en `@pdp/domain` (packages/domain/src/phone.ts).
--
--  1. normalize_phone_digits: forma comparable de un teléfono (la canónica de normalize_mx_phone,
--     pero solo dígitos). Sin ella, "+16195550100" guardado no se encontraba escribiendo
--     "16195550100" sin el "+": normalize_mx_phone conserva el "+" y los textos no coincidían.
--  2. find_customer: compara por esa forma. México se comporta EXACTAMENTE igual que antes (un
--     número mexicano canoniza a 10 dígitos con o sin "+", así que quitar el "+" no cambia nada).
--  3. register_customer: la deduplicación por teléfono también compara por dígitos, para que
--     "+1 619 555 0100" y "1 619 555 0100" no creen dos clientes. El resto del cuerpo es idéntico al
--     de 0043 (correo obligatorio salvo `allow_without_email`, mensajes de carrera, bono de alta).

-- ── 1. Forma comparable ─────────────────────────────────────────────────────
-- normalize_mx_phone da la forma canónica que se GUARDA ("6641234567", "+16195550100");
-- normalize_phone_digits da la que se COMPARA (sin "+"), para que dé igual cómo lo escriba quien busca.
create or replace function normalize_phone_digits(p_raw text) returns text
language sql immutable as $$
  select nullif(regexp_replace(coalesce(normalize_mx_phone(p_raw), ''), '\D', '', 'g'), '')
$$;

comment on function normalize_phone_digits(text) is
  'Teléfono en forma comparable (dígitos de la forma canónica de normalize_mx_phone). Espejo de phoneToE164Digits/parsePhone en @pdp/domain.';

-- ── 2. Búsqueda exacta por QR / código / teléfono / email ───────────────────
-- Mismo orden de preferencia y mismo límite que en 0014; solo cambia la comparación de teléfono.
create or replace function find_customer(p_query text)
returns setof customers language sql stable as $$
  select * from customers c
  where c.deleted_at is null and c.merged_into_id is null
    and (c.qr_token = p_query or c.public_code = upper(btrim(p_query))
         or c.phone = btrim(p_query) or c.email = btrim(p_query)
         or (normalize_phone_digits(p_query) is not null
             and length(normalize_phone_digits(p_query)) >= 10
             and normalize_phone_digits(c.phone::text) = normalize_phone_digits(p_query)))
  order by (c.qr_token = p_query) desc, (c.public_code = upper(btrim(p_query))) desc, c.created_at
  limit 1
$$;

-- ── 3. Alta de cliente ──────────────────────────────────────────────────────
create or replace function register_customer(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid;
  v_phone citext := normalize_mx_phone(p->>'phone');
  v_email citext := nullif(lower(btrim(coalesce(p->>'email',''))), '');
  v_allow_without_email boolean := coalesce((p->>'allow_without_email')::boolean, false);
  v_constraint text;
  v_existing customers%rowtype;
  prog loyalty_program%rowtype;
begin
  if nullif(btrim(coalesce(p->>'full_name','')), '') is null then raise exception 'El nombre es obligatorio' using errcode = 'check_violation'; end if;
  -- Correo obligatorio salvo excepción explícita (importación, seeds, alta rápida de mostrador).
  if v_email is null and not v_allow_without_email then
    raise exception 'El correo electrónico es obligatorio' using errcode = 'check_violation';
  end if;
  if v_phone is null and v_email is null then raise exception 'Se requiere teléfono o email' using errcode = 'check_violation'; end if;
  -- Deduplicación por teléfono en forma comparable (dígitos): da igual si vino con "+" o sin él.
  select * into v_existing from customers c where c.deleted_at is null and c.merged_into_id is null
    and ((v_phone is not null and (c.phone = v_phone or normalize_phone_digits(c.phone::text) = normalize_phone_digits(v_phone::text)))
         or (v_email is not null and c.email = v_email))
  order by c.created_at limit 1;
  if v_existing.id is not null then
    -- Cliente histórico sin correo: se le completa aquí (coalesce), sin crear un duplicado ni tocar
    -- sus puntos, su QR ni su historial.
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
exception when unique_violation then
  -- Carrera entre dos altas simultáneas del mismo correo/teléfono: mensaje claro para la UI y
  -- ninguna pista sobre la cuenta ajena (el texto es idéntico exista o no).
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'customers_phone_idx' then
    raise exception 'Ese teléfono ya está registrado' using errcode = 'unique_violation';
  end if;
  raise exception 'Ese correo ya está registrado' using errcode = 'unique_violation';
end $$;
