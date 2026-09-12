"use server";
import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createPasswordReset, hashPassword, revokeAllSessions } from "@pdp/auth";
import { db, withStaff } from "@/lib/db";
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
  const roles = await db().selectFrom("roles").select(["key", "name", "rank"]).orderBy("rank", "desc").execute();
  const myRank = roles.find((r) => r.key === session.staff.roleKey)?.rank ?? 0;
  return { roles, myRank };
}

/** Un usuario solo administra a otros de rango menor o igual al suyo, y solo asigna roles hasta su propio rango. */
async function targetRank(id: string): Promise<{ rank: number; email: string; is_active: boolean } | null> {
  const r = await db()
    .selectFrom("staff_users as u")
    .innerJoin("roles as r", "r.key", "u.role_key")
    .select(["r.rank", "u.email", "u.is_active"])
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
  const parsed = createSchema.safeParse({ email: str(form, "email") ?? "", full_name: str(form, "full_name") ?? "", role_key: str(form, "role_key") ?? "" });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const { roles, myRank } = await rolesAndRank(s);
  const role = roles.find((r) => r.key === parsed.data.role_key);
  if (!role) return { error: "Rol inválido" };
  if (role.rank > myRank) return { error: `No puedes asignar el rol ${role.name}: es superior al tuyo.` };
  const password = tempPassword();
  try {
    const password_hash = await hashPassword(password);
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("staff_users")
        .values({ email: parsed.data.email, full_name: parsed.data.full_name, role_key: parsed.data.role_key, password_hash, must_change_password: true })
        .execute(),
    );
  } catch (e) {
    return failure("usuarios.create", e);
  }
  revalidate();
  return {
    ok: `Usuario ${parsed.data.email} creado. Copia la contraseña temporal ahora: no se volverá a mostrar.`,
    data: { email: parsed.data.email, password },
  };
}

const updateSchema = z.object({
  full_name: z.string().trim().min(2, "Nombre muy corto").max(120),
  role_key: z.string().min(1),
  is_active: z.boolean(),
});

export async function updateUser(id: string, _prev: ActionState, form: FormData): Promise<ActionState> {
  const s = await requireSession("staff.write");
  if (!zId.safeParse(id).success) return { error: "Usuario inválido" };
  const parsed = updateSchema.safeParse({ full_name: str(form, "full_name") ?? "", role_key: str(form, "role_key") ?? "", is_active: bool(form, "is_active") });
  if (!parsed.success) return { error: zodMessage(parsed.error) };
  const { roles, myRank } = await rolesAndRank(s);
  const target = await targetRank(id);
  if (!target) return { error: "Usuario no encontrado" };
  if (target.rank > myRank) return { error: "No puedes editar a un usuario con rol superior al tuyo." };
  const role = roles.find((r) => r.key === parsed.data.role_key);
  if (!role) return { error: "Rol inválido" };
  if (role.rank > myRank) return { error: `No puedes asignar el rol ${role.name}: es superior al tuyo.` };
  if (id === s.staff.id && (parsed.data.role_key !== s.staff.roleKey || !parsed.data.is_active))
    return { error: "No puedes cambiar tu propio rol ni desactivarte. Pídeselo a otro administrador." };
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
  if (target.rank > myRank) return { error: "No puedes restablecer la contraseña de un rol superior al tuyo." };
  if (!target.is_active) return { error: "El usuario está desactivado; actívalo primero." };
  try {
    const r = await createPasswordReset(db(), target.email);
    if (!r) return { error: "No se pudo generar el enlace." };
    const base = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const url = `${base}/restablecer?token=${encodeURIComponent(r.token)}`;
    await withStaff(db(), s.staff.id, (trx) =>
      trx
        .insertInto("audit_logs")
        .values({ staff_id: s.staff.id, action: "PASSWORD_RESET_LINK", entity: "staff_users", entity_id: id, new_data: JSON.stringify({ email: target.email }) })
        .execute(),
    );
    return { ok: "Enlace generado. Compártelo por un canal seguro; vence en 1 hora y sirve una sola vez.", data: { url } };
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
    trx.insertInto("audit_logs").values({ staff_id: s.staff.id, action: "SESSIONS_REVOKED", entity: "staff_users", entity_id: id }).execute(),
  );
  revalidate(id);
}
