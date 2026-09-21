-- 0048_roles_ceo_admin.sql — Roles CEO y Administradora.
-- Aditiva. Rango reservado 0001–0009 ocupado; estos roles son datos de configuración, no esquema,
-- así que van en una migración propia para que staging y producción los tengan igual.
--
-- Hoy los DOS tienen acceso completo, pero se crean SEPARADOS a propósito: el día que la
-- administradora deje de necesitar algo (o el CEO gane algo que ella no tiene), se cambia un renglón
-- de `role_permissions` y nadie toca código. Fundirlos en uno solo cerraría esa puerta.
--
-- No se tocan los roles existentes (`owner`, `manager`, …): quien ya trabaja con ellos sigue igual.

insert into roles(key, name, rank, is_system) values
  ('ceo',   'CEO',            95, true),
  ('admin', 'Administradora', 85, true)
on conflict (key) do update set name = excluded.name, rank = excluded.rank;

-- Acceso completo: TODOS los permisos que existen hoy.
-- (Mismo criterio que `super_admin` y `owner` en 0001; si mañana se agrega un permiso nuevo, se
-- concede en la migración que lo crea, como ya ocurre con los demás roles de acceso total.)
insert into role_permissions(role_key, permission_key)
select 'ceo', key from permissions
on conflict do nothing;

insert into role_permissions(role_key, permission_key)
select 'admin', key from permissions
on conflict do nothing;

comment on table roles is
  'Roles del CRM. ceo y admin tienen hoy acceso completo pero son roles distintos a propósito, para poder diferenciarlos sin tocar código.';
