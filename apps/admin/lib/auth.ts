import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { SESSION_COOKIE, resolveSession, hasPermission, type StaffSession } from "@pdp/auth";
import { db } from "./db";

/** Sesión del staff actual (cacheada por request). */
export const getSession = cache(async (): Promise<StaffSession | null> => {
  const jar = await cookies();
  return resolveSession(db(), jar.get(SESSION_COOKIE)?.value);
});

/** Exige sesión (y permiso opcional). Redirige a /login o /403. */
export async function requireSession(permission?: string): Promise<StaffSession> {
  const s = await getSession();
  if (!s) {
    const h = await headers();
    const path = h.get("x-pathname") ?? "/";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  if (s.staff.mustChangePassword) {
    const h = await headers();
    if (!(h.get("x-pathname") ?? "").startsWith("/cuenta/contrasena"))
      redirect("/cuenta/contrasena?forzado=1");
  }
  if (permission && !hasPermission(s, permission)) redirect("/403");
  return s;
}

export { hasPermission };

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}
