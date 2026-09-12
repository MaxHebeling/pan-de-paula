-- 0001_foundation.sql
-- Extensiones, helpers, configuración del negocio, staff, roles, permisos, auditoría.
-- Reglas: dinero en centavos enteros (MXN). Timestamps en timestamptz. Soft delete donde importa.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ── Helpers ──────────────────────────────────────────────────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Identidad del actor para auditoría (la app hace: select set_config('app.staff_id', '<uuid>', true))
create or replace function current_staff_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.staff_id', true), '')::uuid
$$;

-- ── Configuración del negocio (singleton) ───────────────────────────────────
create table business_settings (
  id                smallint primary key default 1 check (id = 1),
  name              text not null default 'El Pan de Paula',
  legal_name        text,
  tagline           text default 'Boulangerie · Made with love',
  logo_url          text,
  address           text,
  city              text,
  state             text,
  country           text not null default 'MX',
  phone             text,
  whatsapp          text,
  email             citext,
  instagram_handle  text,
  timezone          text not null default 'America/Tijuana',
  currency          char(3) not null default 'MXN',
  tax_rate_bps      integer not null default 0 check (tax_rate_bps between 0 and 10000), -- IVA en basis points (1600 = 16%)
  prices_include_tax boolean not null default true,
  allow_negative_stock boolean not null default true,
  low_stock_threshold numeric(12,3) not null default 5,
  order_lead_hours  integer not null default 24,
  policies          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger trg_business_settings_updated before update on business_settings
for each row execute function set_updated_at();
insert into business_settings (id) values (1);

-- ── Feature flags ───────────────────────────────────────────────────────────
create table feature_flags (
  key         text primary key,
  enabled     boolean not null default false,
  description text,
  rollout_pct smallint not null default 100 check (rollout_pct between 0 and 100),
  updated_at  timestamptz not null default now()
);
create trigger trg_feature_flags_updated before update on feature_flags
for each row execute function set_updated_at();

-- ── Roles y permisos ────────────────────────────────────────────────────────
create table roles (
  key         text primary key,                -- super_admin, owner, manager, cashier, production, sales, marketing
  name        text not null,
  rank        smallint not null default 0,     -- mayor = más privilegio (para reglas de "no editar a superiores")
  is_system   boolean not null default false
);

create table permissions (
  key         text primary key,                -- ej. pos.sell, products.write, reports.read
  module      text not null,
  description text
);

create table role_permissions (
  role_key        text not null references roles(key) on delete cascade,
  permission_key  text not null references permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);

-- ── Staff (usuarios del CRM/POS) ────────────────────────────────────────────
create table staff_users (
  id              uuid primary key default gen_random_uuid(),
  email           citext not null unique,
  full_name       text not null,
  password_hash   text not null,
  role_key        text not null references roles(key),
  pin_hash        text,                         -- PIN corto para POS (opcional)
  is_active       boolean not null default true,
  must_change_password boolean not null default false,
  last_login_at   timestamptz,
  failed_logins   integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create trigger trg_staff_users_updated before update on staff_users
for each row execute function set_updated_at();

create table staff_sessions (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff_users(id) on delete cascade,
  token_hash    text not null unique,           -- sha256 del token; nunca el token en claro
  user_agent    text,
  ip            inet,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index staff_sessions_staff_idx on staff_sessions(staff_id) where revoked_at is null;
create index staff_sessions_expires_idx on staff_sessions(expires_at);

create table login_attempts (
  id          bigserial primary key,
  email       citext not null,
  ip          inet,
  success     boolean not null,
  created_at  timestamptz not null default now()
);
create index login_attempts_email_idx on login_attempts(email, created_at desc);
create index login_attempts_ip_idx on login_attempts(ip, created_at desc);

create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff_users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- ── Auditoría ───────────────────────────────────────────────────────────────
create table audit_logs (
  id          bigserial primary key,
  staff_id    uuid references staff_users(id) on delete set null,
  action      text not null,                    -- INSERT | UPDATE | DELETE | custom (ej. LOGIN, REFUND)
  entity      text not null,                    -- nombre de tabla / entidad
  entity_id   text,
  old_data    jsonb,
  new_data    jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs(entity, entity_id);
create index audit_logs_created_idx on audit_logs(created_at desc);
create index audit_logs_staff_idx on audit_logs(staff_id);

-- Trigger genérico de auditoría: registra old/new sin campos sensibles.
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id  text;
begin
  if tg_op in ('UPDATE','DELETE') then
    v_old := to_jsonb(old) - 'password_hash' - 'pin_hash' - 'token_hash';
  end if;
  if tg_op in ('INSERT','UPDATE') then
    v_new := to_jsonb(new) - 'password_hash' - 'pin_hash' - 'token_hash';
  end if;
  v_id := coalesce(v_new->>'id', v_old->>'id');
  -- Evita ruido: UPDATE sin cambio real (solo updated_at)
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  insert into audit_logs(staff_id, action, entity, entity_id, old_data, new_data)
  values (current_staff_id(), tg_op, tg_table_name, v_id, v_old, v_new);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger trg_audit_staff_users after insert or update or delete on staff_users
for each row execute function audit_row_change();
create trigger trg_audit_business_settings after update on business_settings
for each row execute function audit_row_change();
create trigger trg_audit_feature_flags after insert or update or delete on feature_flags
for each row execute function audit_row_change();

-- ── Eventos de dominio (append-only) ────────────────────────────────────────
create table domain_events (
  id            bigserial primary key,
  event_type    text not null,                  -- PRODUCT_SOLD, ORDER_PAID, ...
  aggregate     text not null,                  -- order, sale, product, customer, ...
  aggregate_id  text,
  payload       jsonb not null default '{}'::jsonb,
  staff_id      uuid,
  occurred_at   timestamptz not null default now()
);
create index domain_events_type_idx on domain_events(event_type, occurred_at desc);
create index domain_events_agg_idx on domain_events(aggregate, aggregate_id);

create or replace function emit_event(p_type text, p_aggregate text, p_aggregate_id text, p_payload jsonb default '{}'::jsonb)
returns void language sql as $$
  insert into domain_events(event_type, aggregate, aggregate_id, payload, staff_id)
  values (p_type, p_aggregate, p_aggregate_id, coalesce(p_payload, '{}'::jsonb), current_staff_id());
$$;

-- ── Notificaciones internas ────────────────────────────────────────────────
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,                    -- new_order, payment_received, low_stock, birthday, ...
  severity    text not null default 'info' check (severity in ('info','success','warning','error')),
  title       text not null,
  body        text,
  entity      text,
  entity_id   text,
  staff_id    uuid references staff_users(id) on delete cascade,  -- null = para todos
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_unread_idx on notifications(created_at desc) where read_at is null;

-- ── Jobs ────────────────────────────────────────────────────────────────────
create table job_runs (
  id            uuid primary key default gen_random_uuid(),
  job_name      text not null,
  status        text not null default 'running' check (status in ('running','succeeded','failed','skipped')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  result        jsonb,
  error         text,
  lock_key      text                           -- evita ejecuciones concurrentes del mismo job
);
create index job_runs_name_idx on job_runs(job_name, started_at desc);
create unique index job_runs_lock_idx on job_runs(lock_key) where status = 'running';

-- ── Seeds base de roles/permisos ────────────────────────────────────────────
insert into roles(key, name, rank, is_system) values
  ('super_admin', 'Super Admin', 100, true),
  ('owner',       'Dueño',        90, true),
  ('manager',     'Gerente',      70, true),
  ('cashier',     'Caja',         40, true),
  ('production',  'Producción',   40, true),
  ('sales',       'Ventas',       40, true),
  ('marketing',   'Marketing',    40, true);

insert into permissions(key, module, description) values
  ('dashboard.read',   'dashboard', 'Ver dashboard ejecutivo'),
  ('catalog.read',     'catalog',   'Ver productos y categorías'),
  ('catalog.write',    'catalog',   'Crear/editar productos, categorías y precios'),
  ('recipes.read',     'recipes',   'Ver ingredientes, recetas y costos'),
  ('recipes.write',    'recipes',   'Editar ingredientes, recetas y precios de insumos'),
  ('inventory.read',   'inventory', 'Ver inventario y movimientos'),
  ('inventory.write',  'inventory', 'Registrar mermas, correcciones y conteos'),
  ('production.read',  'production','Ver producción'),
  ('production.write', 'production','Registrar producción'),
  ('orders.read',      'orders',    'Ver pedidos'),
  ('orders.write',     'orders',    'Crear/editar pedidos y cambiar estados'),
  ('pos.sell',         'pos',       'Vender en punto de venta'),
  ('pos.refund',       'pos',       'Reembolsar y anular ventas'),
  ('pos.register',     'pos',       'Abrir/cerrar caja'),
  ('customers.read',   'customers', 'Ver clientes'),
  ('customers.write',  'customers', 'Editar clientes, puntos y recompensas'),
  ('loyalty.write',    'loyalty',   'Configurar fidelización y cupones'),
  ('marketing.read',   'marketing', 'Ver Instagram y campañas'),
  ('marketing.write',  'marketing', 'Responder Instagram y campañas'),
  ('reports.read',     'reports',   'Ver reportes'),
  ('reports.export',   'reports',   'Exportar reportes'),
  ('settings.write',   'settings',  'Configurar el negocio'),
  ('staff.write',      'settings',  'Administrar usuarios y roles'),
  ('audit.read',       'settings',  'Ver auditoría');

-- super_admin y owner: todo
insert into role_permissions select 'super_admin', key from permissions;
insert into role_permissions select 'owner', key from permissions;
-- manager: todo menos staff.write
insert into role_permissions select 'manager', key from permissions where key not in ('staff.write');
-- cashier
insert into role_permissions(role_key, permission_key) values
  ('cashier','dashboard.read'),('cashier','catalog.read'),('cashier','inventory.read'),
  ('cashier','orders.read'),('cashier','orders.write'),('cashier','pos.sell'),('cashier','pos.register'),
  ('cashier','customers.read'),('cashier','customers.write');
-- production
insert into role_permissions(role_key, permission_key) values
  ('production','catalog.read'),('production','recipes.read'),('production','inventory.read'),
  ('production','inventory.write'),('production','production.read'),('production','production.write'),
  ('production','orders.read');
-- sales
insert into role_permissions(role_key, permission_key) values
  ('sales','dashboard.read'),('sales','catalog.read'),('sales','orders.read'),('sales','orders.write'),
  ('sales','customers.read'),('sales','customers.write'),('sales','pos.sell'),('sales','reports.read');
-- marketing
insert into role_permissions(role_key, permission_key) values
  ('marketing','dashboard.read'),('marketing','catalog.read'),('marketing','customers.read'),
  ('marketing','loyalty.write'),('marketing','marketing.read'),('marketing','marketing.write'),('marketing','reports.read');

insert into feature_flags(key, enabled, description) values
  ('web_checkout',            true,  'Permite finalizar pedidos en el sitio público'),
  ('mercadopago_online',      false, 'Cobro online con Mercado Pago Checkout Pro'),
  ('mercadopago_point',       false, 'Cobro en POS con terminal Mercado Pago Point'),
  ('mercadopago_qr',          false, 'Cobro en POS con QR dinámico de Mercado Pago'),
  ('instagram_bot',           false, 'Respuestas automáticas en Instagram'),
  ('instagram_ai_replies',    false, 'Respuestas del bot generadas con IA (requiere ANTHROPIC_API_KEY)'),
  ('ingredient_consumption',  false, 'Producción descuenta ingredientes automáticamente'),
  ('email_receipts',          false, 'Enviar comprobantes por email'),
  ('loyalty',                 true,  'Motor de puntos y recompensas'),
  ('pos_offline_queue',       false, 'Cola offline del POS (solo efectivo)');
