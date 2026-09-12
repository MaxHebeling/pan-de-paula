-- 0007_ops_integrations.sql — Webhooks idempotentes, Instagram, leads, importaciones (trazabilidad Sheets), campañas.

create table webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,                    -- mercadopago | meta
  external_id     text not null,                    -- id único del evento/notificación
  event_type      text,
  payload         jsonb not null,
  headers         jsonb,
  signature_valid boolean,
  status          text not null default 'received' check (status in ('received','processing','processed','ignored','failed')),
  attempts        integer not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  unique (provider, external_id)
);
create index webhook_events_pending_idx on webhook_events(received_at) where status in ('received','failed');

create table instagram_conversations (
  id               uuid primary key default gen_random_uuid(),
  ig_user_id       text not null unique,
  ig_username      text,
  customer_id      uuid references customers(id) on delete set null,
  status           text not null default 'open' check (status in ('open','handled','converted','closed')),
  last_message_at  timestamptz,
  last_intent      text,
  assigned_to      uuid references staff_users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_ig_conversations_updated before update on instagram_conversations for each row execute function set_updated_at();

create table instagram_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references instagram_conversations(id) on delete cascade,
  external_mid     text unique,
  direction        text not null check (direction in ('in','out')),
  text             text,
  attachments      jsonb,
  intent           text,
  auto_reply       boolean not null default false,
  sent_by          uuid references staff_users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index instagram_messages_conv_idx on instagram_messages(conversation_id, created_at);

create table leads (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,                          -- instagram | web | qr | whatsapp
  source_ref    text,                                   -- conversation id, etc.
  name          text,
  handle        text,
  phone         text,
  email         citext,
  interest      text,                                   -- producto/consulta
  product_id    uuid references products(id) on delete set null,
  link_sent     text,
  status        text not null default 'new' check (status in ('new','contacted','converted','lost')),
  customer_id   uuid references customers(id) on delete set null,
  order_id      uuid references orders(id) on delete set null,
  converted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_leads_updated before update on leads for each row execute function set_updated_at();

create table marketing_campaigns (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  channel      text not null,                            -- instagram | email | whatsapp | in_store
  starts_at    timestamptz,
  ends_at      timestamptz,
  coupon_id    uuid references coupons(id) on delete set null,
  budget_cents integer,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Importaciones (Google Sheets → sistema) con trazabilidad fila a fila
create table import_batches (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,                            -- google_sheets_xlsx | csv
  file_name    text,
  sheet_name   text,
  entity       text not null,                            -- customers | products | ingredients | recipes | orders | prices
  status       text not null default 'pending' check (status in ('pending','dry_run','applied','failed')),
  total_rows   integer not null default 0,
  ok_rows      integer not null default 0,
  error_rows   integer not null default 0,
  summary      jsonb,
  staff_id     uuid references staff_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  applied_at   timestamptz
);
create table import_rows (
  id            bigserial primary key,
  batch_id      uuid not null references import_batches(id) on delete cascade,
  row_number    integer not null,
  raw           jsonb not null,                          -- fila original tal cual
  normalized    jsonb,                                   -- después de limpiar/mapear
  target_entity text,
  target_id     text,                                    -- id creado/actualizado
  action        text check (action in ('created','updated','skipped','error','matched')),
  error         text,
  created_at    timestamptz not null default now()
);
create index import_rows_batch_idx on import_rows(batch_id, row_number);
