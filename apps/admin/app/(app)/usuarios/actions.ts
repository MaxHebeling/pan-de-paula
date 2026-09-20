"use server";
import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createPasswordReset, hashPassword, revokeAllSessions } from "@pdp/auth";
import { isEmailConfigured, sendStaffInviteEmail } from "@pdp/integrations";
import { db, sql, withStaff } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { bool, failure, str, zId, zodMessage } from "@/lib/forms";
import type { ActionState } from "@/lib/action-state";
import type { StaffSession } from "@pdp/auth";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

/** Contraseña temporal legible (sin 0/O/1/l), 14 caracteres, garantiza letra + número. */
function tempPassword(): string {
  for (;;) {
    let out = "";
    for (let i = 0; i < 14; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    if (/[A-Za-z]/.test(out) && /\d/.test(out)) return out;
  }
}

type RoleRow = { key: string; name: string; rank: number };

async function rolesAndRank(session: StaffSession): Promise<{ roles: RoleRow[]; myRank: number }> {
  const roles = await db()
    .selectFrom("roles")
    .select(["key", "name", "rank"])
    .orderBy("rank", "desc")
    .execute();
  const myRank = roles.find((r) => r.key === session.staff.roleKey)?.rank ?? 0;
  return { roles, myRank };
}

/** Un usuario solo administra a otros de rango menor o igual al suyo, y solo asigna roles hasta su propio rango. */
async function targetRank(id: string): Promise<{
  rank: number;
  email: string;
  is_active: boolean;
  full_name: string;
  role_name: string;
} | null> {
  const r = await db()
    .selectFrom("staff_users as u")
    .innerJoin("roles as r", "r.key", "u.role_key")
    .select(["r.rank", "u.email", "u.is_active", "u.full_name", "r.name as role_name"])
    .where("u.id", "=", id)
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  return r ?? null;
}

function revalidate(id?: string) {
  revalidatePath("/usuarios");
  if (id) revalidatePath(`/usuarios/${id}`);
}

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email inválido").max(254),
  full_name: z.string().trim().min(2, "Nombre muy corto").max(120),
  role_key: z.string().min(1, "Elige un rol"),
});

export async function createUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("staff.write");
  const parsed = createSchema.safeParse({
    email: str(form, "email") ?? "",
    full_name: str(form, "full_name") ?? "",
    role_key: str(form, "role_key") ?? "",
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const { roles, myRank } = await rolesAndRank(s);
  const role = roles.find((r) => r.key === parsed.data.role_key);
  if (!role) return { error: "Rol inválido" };
  if (role.rank > myRank)
    return { error: `No puedes asignar el rol ${role.name}: es superior al tuyo.` };
  const password = tempPassword();
  try {
    const password_hash = await hashPassword(password);
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("staff_users")
        .values({
          email: parsed.data.email,
          full_name: parsed.data.full_name,
          role_key: parsed.data.role_key,
          password_hash,
          must_change_password: true,
        })
        .execute(),
    );
  } catch (e) {
    return failure("usuarios.create", e);
  }
  /*
   * Lo mejor es que la persona cree su propia contraseña: se le manda su enlace de un solo uso (el
   * mismo mecanismo de "restablecer", no uno nuevo) y la contraseña temporal no la ve nadie. Si no
   * hay proveedor de correo, o el envío falla, se muestra la temporal como hasta ahora: preferimos
   * eso a dejar a alguien sin poder entrar.
   */
  const invitada = await invitar(parsed.data.email, parsed.data.full_name, role.name, true);
  revalidate();
  if (invitada)
    return {
      ok: `Usuario ${parsed.data.email} creado. Le enviamos por correo su enlace para crear su contraseña (vence en 1 hora).`,
    };
  return {
    ok: `Usuario ${parsed.data.email} creado. Copia la contraseña temporal ahora: no se volverá a mostrar.`,
    data: { email: parsed.data.email, password },
  };
}

/**
 * Manda a esa persona su enlace de un solo uso para establecer contraseña. Devuelve `false` si no se
 * pudo enviar (sin proveedor de correo o error del envío) para que quien llama ofrezca la alternativa.
 * El enlace NUNCA se escribe en logs: solo viaja en el correo.
 */
async function invitar(
  email: string,
  fullName: string,
  roleName: string,
  isNew: boolean,
): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    const r = await createPasswordReset(db(), email);
    if (!r) return false;
    const base = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const biz = await sql<{
      name: string;
    }>`select name from business_settings where id = 1`.execute(db());
    const res = await sendStaffInviteEmail(email, {
      businessName: biz.rows[0]?.name ?? "El Pan de Paula",
      firstName: fullName.split(/\s+/)[0] ?? fullName,
      roleName,
      link: `${base}/restablecer?token=${encodeURIComponent(r.token)}`,
      minutes: "60",
      isNew,
    });
    if (!res.sent) console.error("[usuarios] la invitación no se pudo enviar", res.error);
    return Boolean(res.sent);
  } catch (e) {
    console.error("[usuarios] la invitación falló", e);
    return false;
  }
}

const updateSchema = z.object({
  full_name: z.string().trim().min(2, "Nombre muy corto").max(120),
  role_key: z.string().min(1),
  is_active: z.boolean(),
});

export async function updateUser(
  id: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const s = await requireSession("staff.write");
  if (!zId.safeParse(id).success) return { error: "Usuario inválido" };
  const parsed = updateSchema.safeParse({
    full_name: str(form, "full_name") ?? "",
    role_key: str(form, "role_key") ?? "",
    is_active: bool(form, "is_active"),
  });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const { roles, myRank } = await rolesAndRank(s);
  const target = await targetRank(id);
  if (!target) return { error: "Usuario no encontrado" };
  if (target.rank > myRank)
    return { error: "No puedes editar a un usuario con rol superior al tuyo." };
  const role = roles.find((r) => r.key === parsed.data.role_key);
  if (!role) return { error: "Rol inválido" };
  if (role.rank > myRank)
    return { error: `No puedes asignar el rol ${role.name}: es superior al tuyo.` };
  if (id === s.staff.id && (parsed.data.role_key !== s.staff.roleKey || !parsed.data.is_active))
    return {
      error: "No puedes cambiar tu propio rol ni desactivarte. Pídeselo a otro administrador.",
    };
  try {
    await withStaff(db(), s.staff.id, async (trx) => {
      await trx.updateTable("staff_users").set(parsed.data).where("id", "=", id).execute();
    });
    if (!parsed.data.is_active && target.is_active) await revokeAllSessions(db(), id);
  } catch (e) {
    return failure("usuarios.update", e);
  }
  revalidate(id);
  return { ok: "Usuario guardado." };
}

export async function generateResetLink(id: string, _prev: ActionState): Promise<ActionState> {
  const s = await requireSession("staff.write");
  if (!zId.safeParse(id).success) return { error: "Usuario inválido" };
  const { myRank } = await rolesAndRank(s);
  const target = await targetRank(id);
  if (!target) return { error: "Usuario no encontrado" };
  if (target.rank > myRank)
    return { error: "No puedes restablecer la contraseña de un rol superior al tuyo." };
  // Regresión auditoría 360°: un dueño podía tomar la cuenta de otro dueño generando su enlace de restablecimiento.
  // Mismo rango: solo super_admin (o uno mismo, que usa "Cambiar contraseña").
  if (target.rank === myRank && s.staff.roleKey !== "super_admin" && id !== s.staff.id)
    return {
      error: "Solo un Super Admin puede restablecer la contraseña de alguien con tu mismo rol.",
    };
  if (!target.is_active) return { error: "El usuario está desactivado; actívalo primero." };
  try {
    const r = await createPasswordReset(db(), target.email);
    if (!r) return { error: "No se pudo generar el enlace." };
    const base = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const url = `${base}/restablecer?token=${encodeURIComponent(r.token)}`;
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("audit_logs")
        .values({
          staff_id: s.staff.id,
          action: "PASSWORD_RESET_LINK",
          entity: "staff_users",
          entity_id: id,
          new_data: JSON.stringify({ email: target.email }),
        })
        .execute(),
    );
    // Si hay correo configurado, además se lo mandamos: es más seguro que pasarlo por WhatsApp.
    const enviado = await invitar(target.email, target.full_name, target.role_name, false);
    return {
      ok: enviado
        ? `Enlace enviado a ${target.email}. Vence en 1 hora y sirve una sola vez; cópialo abajo si además quieres dárselo a mano.`
        : "Enlace generado. Compártelo por un canal seguro; vence en 1 hora y sirve una sola vez.",
      data: { url },
    };
  } catch (e) {
    return failure("usuarios.reset", e);
  }
}

export async function revokeSessions(id: string): Promise<void> {
  const s = await requireSession("staff.write");
  if (!zId.safeParse(id).success) return;
  const { myRank } = await rolesAndRank(s);
  const target = await targetRank(id);
  if (!target || target.rank > myRank) return;
  await revokeAllSessions(db(), id);
  await withStaff(db(), s.staff.id, (trx) =>
    trx
      .insertInto("audit_logs")
      .values({
        staff_id: s.staff.id,
        action: "SESSIONS_REVOKED",
        entity: "staff_users",
        entity_id: id,
      })
      .execute(),
  );
  revalidate(id);
}
