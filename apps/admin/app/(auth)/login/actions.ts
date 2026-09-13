"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { login, SESSION_COOKIE } from "@pdp/auth";
import { db } from "@/lib/db";
import { clientIp, landingPath, safeNextPath, sessionCookieOptions } from "@/lib/auth";

const schema = z.object({
  email: z.string().trim().max(254).email(),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

export type LoginState = { error?: string };

const MESSAGES = {
  invalid_credentials: "Correo o contraseña incorrectos.",
  locked: "Cuenta bloqueada temporalmente por intentos fallidos. Intenta en 15 minutos.",
  inactive: "Tu cuenta está desactivada.",
  rate_limited: "Demasiados intentos. Espera unos minutos.",
} as const;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: form.get("email"),
    password: form.get("password"),
    next: form.get("next") ?? undefined,
  });
  if (!parsed.success) return { error: "Escribe un correo válido y tu contraseña." };
  const h = await headers();
  let r;
  try {
    r = await login(db(), {
      email: parsed.data.email,
      password: parsed.data.password,
      ip: await clientIp(),
      userAgent: h.get("user-agent"),
    });
  } catch (e) {
    console.error("[login] error inesperado", (e as Error).message);
    return { error: "No se pudo iniciar sesión. Intenta de nuevo en unos segundos." };
  }
  if (!r.ok) return { error: MESSAGES[r.reason] };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, r.token, sessionCookieOptions(r.session.expiresAt));
  const next = safeNextPath(parsed.data.next) ?? landingPath(r.session);
  redirect(r.session.staff.mustChangePassword ? "/cuenta/contrasena?forzado=1" : next);
}
