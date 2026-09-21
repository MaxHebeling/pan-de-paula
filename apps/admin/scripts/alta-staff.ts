/**
 * Da de alta (o actualiza) a alguien del equipo en el CRM y le manda su invitación.
 *
 *   bash scripts/alta-staff.sh production "Paulina Gonzalez <pgonzalezt17@gmail.com>" ceo --apply
 *   bash scripts/alta-staff.sh production "Karla Santoyo Escarcega <Karla-esc@hotmail.com>" admin
 *
 * Lo que hace y lo que NO hace:
 *   · NUNCA fija una contraseña conocida. La cuenta nace con una aleatoria que nadie ve (ni queda en
 *     logs, ni en el repositorio, ni en el .env) y marcada para cambiarse; quien entra crea la suya
 *     con el enlace de un solo uso que le llega por correo. Es el MISMO mecanismo de "restablecer"
 *     del CRM, no uno nuevo.
 *   · Si el correo ya existe, NO duplica: actualiza el rol y el nombre si hacen falta, lo reactiva si
 *     estaba desactivado y le manda su enlace. La comparación es sin distinguir mayúsculas (la
 *     columna es `citext`), así que `Karla-esc@…` y `karla-esc@…` son la misma persona.
 *   · Sin `--apply` solo dice qué haría.
 *
 * El enlace no se imprime: viaja en el correo. Si no hay proveedor de correo configurado, se avisa y
 * el enlace se genera desde el CRM (Usuarios → Generar enlace), que sí lo muestra en pantalla.
 */
import { randomBytes } from "node:crypto";
import { createPasswordReset, hashPassword } from "@pdp/auth";
import { createDb, sql } from "@pdp/db";
import { isEmailConfigured, sendStaffInviteEmail } from "@pdp/integrations";

type Persona = { nombre: string; email: string };

/** Acepta `Nombre <correo>` o `correo` a secas. */
function parsePersona(arg: string): Persona {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(arg);
  if (m) return { nombre: m[1]!.trim(), email: m[2]!.trim().toLowerCase() };
  return { nombre: "", email: arg.trim().toLowerCase() };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const [personaArg, roleKey] = argv.filter((a) => a !== "--apply");
  if (!personaArg || !roleKey)
    throw new Error('Uso: alta-staff.sh <entorno> "Nombre <correo>" <rol> [--apply]');
  const persona = parsePersona(personaArg);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(persona.email))
    throw new Error(`Correo inválido: ${persona.email}`);

  /*
   * Sin `ssl`: `createDb` lo resuelve con el entorno (DATABASE_SSL + DATABASE_CA_CERT). Pasarle
   * `ssl: true` a mano descartaba la CA de Supabase y la conexión moría con "self-signed certificate
   * in certificate chain".
   */
  const { db, pool } = createDb({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const rol = await sql<{ key: string; name: string }>`
      select key, name from roles where key = ${roleKey}`.execute(db);
    if (!rol.rows[0]) throw new Error(`El rol "${roleKey}" no existe`);
    const rolName = rol.rows[0].name;

    const existente = await sql<{
      id: string;
      full_name: string;
      role_key: string;
      is_active: boolean;
      deleted_at: Date | null;
    }>`select id, full_name, role_key, is_active, deleted_at
         from staff_users where email = ${persona.email}`.execute(db);
    const actual = existente.rows[0];

    console.log(`▶ ${apply ? "APLICANDO" : "Simulación"} en ${process.env.APP_ENV ?? "local"}`);
    console.log(`· ${persona.email} → rol ${rolName}`);

    let id: string;
    if (actual) {
      const cambios: string[] = [];
      if (actual.role_key !== roleKey) cambios.push(`rol ${actual.role_key} → ${roleKey}`);
      if (persona.nombre && actual.full_name !== persona.nombre)
        cambios.push(`nombre "${actual.full_name}" → "${persona.nombre}"`);
      if (!actual.is_active || actual.deleted_at) cambios.push("reactivar");
      console.log(
        cambios.length ? `  · ya existe: ${cambios.join(", ")}` : "  · ya existe y está al día",
      );
      id = actual.id;
      if (apply && cambios.length) {
        await db.transaction().execute(async (trx) => {
          // La auditoría registra quién lo hizo; aquí lo hace la operación, no una persona del CRM.
          await sql`update staff_users
                       set role_key = ${roleKey},
                           full_name = ${persona.nombre || actual.full_name},
                           is_active = true, deleted_at = null
                     where id = ${id}`.execute(trx);
          await sql`insert into audit_logs(staff_id, action, entity, entity_id, new_data)
                    values (null, 'STAFF_ROLE_SET', 'staff_users', ${id},
                            ${JSON.stringify({ role_key: roleKey, via: "alta-staff" })}::jsonb)`.execute(
            trx,
          );
        });
      }
    } else {
      console.log("  · alta nueva (contraseña aleatoria que nadie ve; la crea ella con su enlace)");
      if (!persona.nombre) throw new Error('Falta el nombre: usa "Nombre Apellido <correo>"');
      id = "";
      if (apply) {
        // Contraseña imposible de adivinar y que nunca se muestra: existe solo para que la fila sea
        // válida hasta que la persona establezca la suya con el enlace.
        const hash = await hashPassword(randomBytes(32).toString("base64url"));
        const r = await db.transaction().execute(async (trx) => {
          const ins = await sql<{ id: string }>`
            insert into staff_users(email, full_name, password_hash, role_key, is_active, must_change_password)
            values (${persona.email}, ${persona.nombre}, ${hash}, ${roleKey}, true, true)
            returning id`.execute(trx);
          const nuevo = ins.rows[0]!.id;
          await sql`insert into audit_logs(staff_id, action, entity, entity_id, new_data)
                    values (null, 'STAFF_CREATED', 'staff_users', ${nuevo},
                            ${JSON.stringify({ email: persona.email, role_key: roleKey, via: "alta-staff" })}::jsonb)`.execute(
            trx,
          );
          return nuevo;
        });
        id = r;
      }
    }

    if (!apply) {
      console.log("  · se le enviaría su enlace para crear contraseña");
      console.log("\n· Simulación: no se escribió nada. Para aplicar, repite con --apply");
      return;
    }

    if (!isEmailConfigured()) {
      console.log(
        "  ✗ sin proveedor de correo: genera su enlace desde el CRM (Usuarios → Generar enlace)",
      );
      return;
    }
    const reset = await createPasswordReset(db, persona.email);
    if (!reset) {
      console.log("  ✗ no se pudo generar el enlace (¿usuario inactivo?)");
      return;
    }
    const base = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const biz = await sql<{
      name: string;
    }>`select name from business_settings where id = 1`.execute(db);
    const nombre = persona.nombre || actual?.full_name || persona.email;
    const res = await sendStaffInviteEmail(persona.email, {
      businessName: biz.rows[0]?.name ?? "El Pan de Paula",
      firstName: nombre.split(/\s+/)[0] ?? nombre,
      roleName: rolName,
      link: `${base}/restablecer?token=${encodeURIComponent(reset.token)}`,
      minutes: "60",
      isNew: !actual,
    });
    console.log(
      res.sent
        ? `  ✔ invitación enviada a ${persona.email} (vence en 1 hora, un solo uso)`
        : `  ✗ la invitación no salió: ${res.error ?? res.skipped}`,
    );
  } finally {
    await db.destroy();
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
