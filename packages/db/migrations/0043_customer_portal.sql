-- 0043_customer_portal.sql — Portal del cliente en el sitio público: correo obligatorio en las altas
-- humanas, enlaces de acceso de un solo uso y sesiones de cliente.
-- Aditiva. Rango reservado 0040–0049 (clientes/fidelización).
--
--  1. register_customer: el correo pasa a ser OBLIGATORIO por defecto. La excepción documentada
--     `allow_without_email` la usan la importación histórica, los seeds y la alta rápida del POS
--     (mostrador con fila: pedir el correo ahí frenaría la venta). Los clientes históricos sin correo
--     se conservan intactos y el CRM puede completarlos después sin duplicarlos (la rama de "ya existe"
--     rellena el correo con coalesce, no crea un registro nuevo).
--  2. customer_access_tokens: enlace de acceso de un solo uso (sha256 del token, caducidad corta).
--     Mismo diseño que password_reset_tokens.
--  3. customer_sessions: sesión del cliente en cookie httpOnly. Mismo diseño que staff_sessions
--     (hash del token, expiración, last_seen_at, revoked_at).

-- ── 1. Correo obligatorio en las altas humanas ──────────────────────────────
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
  select * into v_existing from customers c where c.deleted_at is null and c.merged_into_id is null
    and ((v_phone is not null and (c.phone = v_phone or normalize_mx_phone(c.phone::text) = v_phone::text))
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

-- ── 2. Enlaces de acceso de un solo uso ─────────────────────────────────────
-- El token en claro solo viaja en el enlace (correo o copia manual desde el CRM); en la base vive su sha256.
create table customer_access_tokens (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  token_hash   text not null unique,
  requested_by text not null default 'self' check (requested_by in ('self', 'staff')),
  staff_id     uuid references staff_users(id) on delete set null,
  ip           inet,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index customer_access_tokens_customer_idx on customer_access_tokens(customer_id, created_at desc);
create index customer_access_tokens_expires_idx on customer_access_tokens(expires_at);

-- ── 3. Sesiones del cliente ─────────────────────────────────────────────────
create table customer_sessions (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  token_hash   text not null unique,
  user_agent   text,
  ip           inet,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index customer_sessions_customer_idx on customer_sessions(customer_id) where revoked_at is null;
create index customer_sessions_expires_idx on customer_sessions(expires_at);

-- Misma política de seguridad que el resto del esquema (0009/0080): RLS + acceso solo para pdp_app.
alter table customer_access_tokens enable row level security;
create policy pdp_app_all on customer_access_tokens for all to pdp_app using (true) with check (true);
alter table customer_sessions enable row level security;
create policy pdp_app_all on customer_sessions for all to pdp_app using (true) with check (true);

revoke all on customer_access_tokens, customer_sessions from public, anon, authenticated;
grant select, insert, update, delete on customer_access_tokens, customer_sessions to pdp_app;
