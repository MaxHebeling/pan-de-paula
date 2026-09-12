"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { changePassword, verifyPassword } from "@pdp/auth";
import { db, sql } from "@/lib/db";
import { requireSession } from "@/lib/auth";

const schema = z
  .object({ current: z.string().min(1), next: z.string().min(10), confirm: z.string() })
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
  const row = await sql<{
    password_hash: string;
  }>`select password_hash from staff_users where id = ${s.staff.id}`.execute(db());
  if (!(await verifyPassword(row.rows[0]!.password_hash, parsed.data.current)))
    return { error: "La contraseña actual no es correcta" };
  try {
    await changePassword(db(), s.staff.id, parsed.data.next);
  } catch (e) {
    return { error: (e as Error).message };
  }
  redirect("/dashboard");
}
