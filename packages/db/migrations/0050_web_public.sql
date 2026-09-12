-- 0050_web_public.sql — Sitio público: token opaco para consultar un pedido y rate limiting de formularios públicos.
-- Aditiva. Rango reservado 0050–0059 (sitio público).

-- Token opaco por pedido: la página /pedido/[folio]?t=<token> solo responde si folio y token coinciden.
alter table orders add column if not exists public_token text not null default encode(gen_random_bytes(16), 'hex');
create unique index if not exists orders_public_token_idx on orders(public_token);

-- Rate limiting por clave (IP) y ruta en ventanas fijas. Se consulta desde server actions públicas (checkout, registro).
create table rate_limits (
  key          text not null,                 -- normalmente la IP del cliente
  route        text not null,                 -- ej. 'checkout', 'register'
  window_start timestamptz not null,
  hits         integer not null default 0 check (hits >= 0),
  updated_at   timestamptz not null default now(),
  primary key (key, route, window_start)
);
create index rate_limits_window_idx on rate_limits(window_start);

-- Registra un intento y devuelve si está permitido. Ventana fija de p_window_seconds con máximo p_max intentos.
-- Devuelve {allowed, hits, limit, resets_at}. Limpia ventanas antiguas de forma oportunista.
create or replace function rate_limit_hit(p_key text, p_route text, p_window_seconds integer default 600, p_max integer default 20)
returns jsonb language plpgsql as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  if p_key is null or btrim(p_key) = '' then raise exception 'rate_limit_hit: clave vacía' using errcode = 'check_violation'; end if;
  insert into rate_limits(key, route, window_start, hits) values (btrim(p_key), p_route, v_start, 1)
  on conflict (key, route, window_start) do update set hits = rate_limits.hits + 1, updated_at = now()
  returning hits into v_hits;
  if random() < 0.05 then
    delete from rate_limits where window_start < now() - make_interval(secs => p_window_seconds * 2);
  end if;
  return jsonb_build_object(
    'allowed', v_hits <= p_max,
    'hits', v_hits,
    'limit', p_max,
    'resets_at', v_start + make_interval(secs => p_window_seconds)
  );
end $$;

-- Misma política de seguridad que el resto del esquema (0009): RLS + acceso total solo para pdp_app.
alter table rate_limits enable row level security;
create policy pdp_app_all on rate_limits for all to pdp_app using (true) with check (true);

-- Las funciones nuevas heredan EXECUTE a PUBLIC aunque 0009 ajustó los default privileges; se cierra explícitamente.
revoke execute on function rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function rate_limit_hit(text, text, integer, integer) to pdp_app;
