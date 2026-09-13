-- 0012_audit_auth.sql — Auditoría de staff_users sin ruido de login.
-- Cada login (y cada intento fallido) actualizaba failed_logins / locked_until / last_login_at y el trigger
-- genérico dejaba un UPDATE "sistema" por cada uno (sin actor), enterrando los cambios reales (rol, estado, nombre).
-- El login ya deja su propio evento LOGIN con staff_id; estos contadores salen del diff auditado.
-- Se mantienen fuera password_hash / pin_hash / token_hash (nunca se registran).

create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_id  text;
begin
  if tg_op in ('UPDATE','DELETE') then
    v_old := to_jsonb(old) - 'password_hash' - 'pin_hash' - 'token_hash'
             - 'failed_logins' - 'locked_until' - 'last_login_at';
  end if;
  if tg_op in ('INSERT','UPDATE') then
    v_new := to_jsonb(new) - 'password_hash' - 'pin_hash' - 'token_hash'
             - 'failed_logins' - 'locked_until' - 'last_login_at';
  end if;
  v_id := coalesce(v_new->>'id', v_old->>'id');
  -- Evita ruido: UPDATE sin cambio real (solo updated_at o campos excluidos)
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  insert into audit_logs(staff_id, action, entity, entity_id, old_data, new_data)
  values (current_staff_id(), tg_op, tg_table_name, v_id, v_old, v_new);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
