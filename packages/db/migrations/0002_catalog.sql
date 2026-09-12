-- 0002_catalog.sql — Categorías, productos, variantes (como productos hijos), imágenes, precios con historial.

create table categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text,
  image_url   text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create trigger trg_categories_updated before update on categories for each row execute function set_updated_at();

create table products (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text unique,
  slug                text not null unique,
  name                text not null,
  short_description   text,
  description         text,
  category_id         uuid references categories(id) on delete set null,
  parent_id           uuid references products(id) on delete cascade,  -- variante de otro producto
  variant_label       text,                                              -- ej. "Chico", "Nutella"
  unit_label          text not null default 'pieza',                     -- pieza, paquete, caja
  highlighted_ingredients text[] not null default '{}',
  allergens           text[] not null default '{}',
  tags                text[] not null default '{}',
  is_active           boolean not null default true,     -- visible/vendible
  is_featured         boolean not null default false,
  show_on_web         boolean not null default true,
  show_on_pos         boolean not null default true,
  track_stock         boolean not null default true,
  allow_preorder      boolean not null default true,
  requires_preorder   boolean not null default false,    -- solo bajo pedido
  preparation_hours   integer,
  season_start        date,
  season_end          date,
  sort_order          integer not null default 0,
  pos_favorite        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint products_variant_chk check ((parent_id is null) or (variant_label is not null))
);
create index products_category_idx on products(category_id) where deleted_at is null;
create index products_parent_idx on products(parent_id);
create index products_active_idx on products(is_active, show_on_web) where deleted_at is null;
create trigger trg_products_updated before update on products for each row execute function set_updated_at();
create trigger trg_audit_products after insert or update or delete on products for each row execute function audit_row_change();

create table product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  url         text not null,
  alt         text,
  sort_order  integer not null default 0,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index product_images_product_idx on product_images(product_id, sort_order);
create unique index product_images_primary_idx on product_images(product_id) where is_primary;

-- Precios con historial. Un producto puede tener precio distinto por canal y precio promocional con vigencia.
create type price_channel as enum ('all', 'web', 'pos');
create type price_kind as enum ('regular', 'promo');

create table product_prices (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  channel       price_channel not null default 'all',
  kind          price_kind not null default 'regular',
  price_cents   integer not null check (price_cents >= 0),
  valid_from    timestamptz not null default now(),
  valid_to      timestamptz,
  label         text,                                  -- ej. "Promo San Valentín"
  created_by    uuid references staff_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint product_prices_range_chk check (valid_to is null or valid_to > valid_from)
);
create index product_prices_lookup_idx on product_prices(product_id, channel, kind, valid_from desc);
create trigger trg_audit_product_prices after insert or update or delete on product_prices for each row execute function audit_row_change();

-- Precio vigente: promo válida > regular del canal > regular 'all'
create or replace function current_price_cents(p_product_id uuid, p_channel price_channel default 'all', p_at timestamptz default now())
returns integer language sql stable as $$
  select price_cents from (
    select price_cents,
           case when kind = 'promo' then 0 else 1 end as kind_rank,
           case when channel = p_channel then 0 else 1 end as channel_rank,
           valid_from
    from product_prices
    where product_id = p_product_id
      and (channel = p_channel or channel = 'all')
      and valid_from <= p_at
      and (valid_to is null or valid_to > p_at)
  ) x
  order by kind_rank, channel_rank, valid_from desc
  limit 1
$$;

-- Vista de catálogo con precio vigente (POS y web usan la misma fuente)
create or replace view catalog_products as
select p.*,
       c.name as category_name,
       c.slug as category_slug,
       current_price_cents(p.id, 'web')  as web_price_cents,
       current_price_cents(p.id, 'pos')  as pos_price_cents,
       (select url from product_images i where i.product_id = p.id order by is_primary desc, sort_order asc limit 1) as primary_image_url
from products p
left join categories c on c.id = p.category_id
where p.deleted_at is null;
