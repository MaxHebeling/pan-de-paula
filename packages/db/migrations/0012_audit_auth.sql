-- 0012_audit_auth.sql — Auditoría de staff_users sin ruido de login + auditoría de horarios y puntos de retiro.
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
  -- Identificador: id, o la clave natural de tablas sin id (feature_flags.key, business_hours.weekday)
  v_id := coalesce(v_new->>'id', v_old->>'id', v_new->>'key', v_old->>'key', v_new->>'weekday', v_old->>'weekday');
  -- Evita ruido: UPDATE sin cambio real (solo updated_at o campos excluidos)
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  insert into audit_logs(staff_id, action, entity, entity_id, old_data, new_data)
  values (current_staff_id(), tg_op, tg_table_name, v_id, v_old, v_new);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Horarios y puntos de retiro se editan desde /configuracion pero no tenían trigger: sus cambios no aparecían
-- en /auditoria (solo quedaba un domain_event). Mismo trigger genérico, con el actor de app.staff_id.
drop trigger if exists trg_audit_business_hours on business_hours;
create trigger trg_audit_business_hours after insert or update or delete on business_hours
for each row execute function audit_row_change();
drop trigger if exists trg_audit_pickup_points on pickup_points;
create trigger trg_audit_pickup_points after insert or update or delete on pickup_points
for each row execute function audit_row_change();
