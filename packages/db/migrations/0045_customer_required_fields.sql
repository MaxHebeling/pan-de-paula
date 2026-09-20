-- 0045_customer_required_fields.sql — Alta de cliente con datos completos.
-- Aditiva, sin cambios de esquema. Rango reservado 0040–0049 (clientes/fidelización).
--
-- Desde aquí, un alta humana (mostrador, sitio, CRM) exige NOMBRE + TELÉFONO + CORREO +
-- FECHA DE NACIMIENTO. Antes solo se exigían nombre y correo (0043) y "teléfono o correo" (0004).
--
-- Por qué en la función y no con `not null` en la tabla: los clientes históricos existen y tienen
-- huecos (ver docs/CUSTOMER_PORTAL.md). Un `not null` los rompería o exigiría inventarles datos, y
-- eso no se hace. La regla vive donde se dan de alta —`register_customer`— así que la cumplen por
-- igual el POS, el sitio y el CRM, sin que nadie pueda saltársela desde su propia capa.
--
-- Excepción documentada `allow_incomplete` (alias histórico: `allow_without_email`): importación de
-- clientes viejos, seeds y pruebas. NO la usan las altas humanas.
--
-- Cumpleaños: se guarda UNA sola fecha (`customers.birthday`, ya existente). El día y el mes del
-- festejo se derivan de ella con `observed_birthday`/`celebrates_birthday_on` (0042); no se guarda
-- una segunda fecha redundante.

create or replace function register_customer(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id uuid;
  v_phone citext := normalize_mx_phone(p->>'phone');
  v_email citext := nullif(lower(btrim(coalesce(p->>'email',''))), '');
  v_birthday date := nullif(btrim(coalesce(p->>'birthday','')), '')::date;
  -- `allow_without_email` se mantiene como alias para no romper importadores, seeds ni pruebas ya escritos.
  v_allow_incomplete boolean := coalesce((p->>'allow_incomplete')::boolean,
                                         (p->>'allow_without_email')::boolean, false);
  v_constraint text;
  v_existing customers%rowtype;
  prog loyalty_program%rowtype;
begin
  if nullif(btrim(coalesce(p->>'full_name','')), '') is null then
    raise exception 'El nombre es obligatorio' using errcode = 'check_violation';
  end if;
  -- Datos obligatorios del alta humana. Los mensajes son los que ve la persona en el formulario.
  if not v_allow_incomplete then
    if v_email is null then
      raise exception 'El correo electrónico es obligatorio' using errcode = 'check_violation';
    end if;
    if v_phone is null then
      raise exception 'El número de celular es obligatorio' using errcode = 'check_violation';
    end if;
    if v_birthday is null then
      raise exception 'La fecha de nacimiento es obligatoria' using errcode = 'check_violation';
    end if;
  end if;
  -- Una fecha de nacimiento futura o imposible es un error de captura, venga de donde venga.
  if v_birthday is not null and v_birthday > current_date then
    raise exception 'La fecha de nacimiento no puede ser futura' using errcode = 'check_violation';
  end if;
  if v_birthday is not null and v_birthday < date '1900-01-01' then
    raise exception 'Revisa la fecha de nacimiento' using errcode = 'check_violation';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Se requiere teléfono o email' using errcode = 'check_violation';
  end if;
  -- Deduplicación por teléfono en forma comparable (dígitos): da igual si vino con "+" o sin él.
  select * into v_existing from customers c where c.deleted_at is null and c.merged_into_id is null
    and ((v_phone is not null and (c.phone = v_phone or normalize_phone_digits(c.phone::text) = normalize_phone_digits(v_phone::text)))
         or (v_email is not null and c.email = v_email))
  order by c.created_at limit 1;
  if v_existing.id is not null then
    -- Cliente histórico incompleto: se le completan los huecos aquí (coalesce), sin crear un
    -- duplicado ni tocar sus puntos, su QR, su código ni su historial.
    update customers set
      email = coalesce(email, v_email), phone = coalesce(phone, v_phone),
      birthday = coalesce(birthday, v_birthday),
      marketing_consent = marketing_consent or coalesce((p->>'marketing_consent')::boolean, false)
    where id = v_existing.id;
    return jsonb_build_object('customer_id', v_existing.id, 'public_code', v_existing.public_code, 'qr_token', v_existing.qr_token, 'created', false);
  end if;
  insert into customers(full_name, phone, email, birthday, source, marketing_consent, notes)
  values (btrim(p->>'full_name'), v_phone, v_email, v_birthday, coalesce(p->>'source','pos'), coalesce((p->>'marketing_consent')::boolean, false), p->>'notes')
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

comment on function register_customer(jsonb) is
  'Alta de cliente idempotente por teléfono/correo. Exige nombre, teléfono, correo y fecha de nacimiento; '
  'la excepción allow_incomplete (alias allow_without_email) es solo para importación, seeds y pruebas. '
  'Un cliente que ya existe NO se duplica: se le completan los huecos y se devuelve created=false.';

-- Cuánto le falta a un cliente para tener su ficha completa. La usan el CRM (aviso "datos pendientes")
-- y el portal (para pedirle al cliente que los complete). No inventa nada: solo mira lo que hay.
create or replace function customer_missing_fields(p_id uuid) returns text[]
language sql stable as $$
  select coalesce(array_remove(array[
      case when c.email    is null then 'email'    end,
      case when c.phone    is null then 'phone'    end,
      case when c.birthday is null then 'birthday' end
    ], null), '{}')
    from customers c where c.id = p_id and c.deleted_at is null
$$;

comment on function customer_missing_fields(uuid) is
  'Campos obligatorios que le faltan a un cliente histórico (email, phone, birthday), para pedirlos sin bloquearlo.';

revoke all on function customer_missing_fields(uuid) from public, anon, authenticated;
grant execute on function customer_missing_fields(uuid) to pdp_app;
