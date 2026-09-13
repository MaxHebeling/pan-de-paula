"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { changePassword, validatePasswordPolicy, verifyPassword } from "@pdp/auth";
import { db, sql } from "@/lib/db";
import { landingPath, requireSession } from "@/lib/auth";

const schema = z
  .object({
    current: z.string().min(1, "Escribe tu contraseña actual").max(1024),
    next: z.string().min(10, "Mínimo 10 caracteres").max(128, "Máximo 128 caracteres"),
    confirm: z.string().max(1024),
  })
  .refine((v) => v.next === v.confirm, {
    message: "Las contraseñas no coinciden",
    path: ["confirm"],
  });

export async function changePasswordAction(
  _prev: { error?: string },
  form: FormData,
): Promise<{ error?: string }> {
  const s = await requireSession();
  const parsed = schema.safeParse({
    current: form.get("current"),
    next: form.get("next"),
    confirm: form.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    validatePasswordPolicy(parsed.data.next);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const row = await sql<{
    password_hash: string;
  }>`select password_hash from staff_users where id = ${s.staff.id}`.execute(db());
  if (!(await verifyPassword(row.rows[0]!.password_hash, parsed.data.current)))
    return { error: "La contraseña actual no es correcta" };
  try {
    // Conserva la sesión actual y cierra las demás (si alguien más tenía la clave, pierde el acceso).
    await changePassword(db(), s.staff.id, parsed.data.next, { keepSessionId: s.sessionId });
  } catch (e) {
    const msg = (e as Error).message;
    if (/contraseña/i.test(msg)) return { error: msg };
    console.error("[cuenta/contrasena] error al cambiar contraseña", msg);
    return { error: "No se pudo cambiar la contraseña. Intenta de nuevo." };
  }
  redirect(landingPath(s));
}
