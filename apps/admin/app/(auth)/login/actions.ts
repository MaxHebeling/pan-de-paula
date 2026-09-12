"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { login, SESSION_COOKIE } from "@pdp/auth";
import { db } from "@/lib/db";
import { sessionCookieOptions } from "@/lib/auth";

const schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: form.get("email"),
    password: form.get("password"),
    next: form.get("next") ?? undefined,
  });
  if (!parsed.success) return { error: "Escribe un correo válido y tu contraseña." };
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip") || null;
  const r = await login(db(), {
    email: parsed.data.email,
    password: parsed.data.password,
    ip,
    userAgent: h.get("user-agent"),
  });
  if (!r.ok) {
    const msg = {
      invalid_credentials: "Correo o contraseña incorrectos.",
      locked: "Cuenta bloqueada temporalmente por intentos fallidos. Intenta en 15 minutos.",
      inactive: "Tu cuenta está desactivada.",
      rate_limited: "Demasiados intentos. Espera unos minutos.",
    }[r.reason];
    return { error: msg };
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, r.token, sessionCookieOptions(r.session.expiresAt));
  const next =
    parsed.data.next && parsed.data.next.startsWith("/") && !parsed.data.next.startsWith("//")
      ? parsed.data.next
      : "/dashboard";
  redirect(r.session.staff.mustChangePassword ? "/cuenta/contrasena?forzado=1" : next);
}
