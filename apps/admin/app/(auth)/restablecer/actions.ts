"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { consumePasswordReset, validatePasswordPolicy } from "@pdp/auth";
import { db } from "@/lib/db";
import type { ActionState } from "@/lib/action-state";

const schema = z
  .object({
    token: z.string().min(16, "Enlace inválido").max(200),
    password: z.string().min(10, "Mínimo 10 caracteres"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Las contraseñas no coinciden",
    path: ["confirm"],
  });

export async function resetPassword(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = schema.safeParse({
    token: form.get("token"),
    password: form.get("password"),
    confirm: form.get("confirm"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  try {
    validatePasswordPolicy(parsed.data.password);
  } catch (e) {
    return { error: (e as Error).message };
  }
  let ok = false;
  try {
    ok = await consumePasswordReset(db(), parsed.data.token, parsed.data.password);
  } catch (e) {
    console.error("[restablecer] error al consumir token", (e as Error).message);
    return { error: "No se pudo restablecer la contraseña. Intenta de nuevo." };
  }
  if (!ok) return { error: "El enlace no es válido o ya venció. Solicita uno nuevo." };
  redirect("/login?restablecida=1");
}
