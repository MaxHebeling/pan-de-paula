import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  SESSION_COOKIE,
  resolveSession,
  hasPermission,
  clientIpFromHeaders,
  type StaffSession,
} from "@pdp/auth";
import { NAV } from "./nav";
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

/** IP del cliente saneada (null si las cabeceras no traen una IP válida). Nunca se castea texto crudo a inet. */
export async function clientIp(): Promise<string | null> {
  const h = await headers();
  return clientIpFromHeaders((n) => h.get(n));
}

/**
 * Ruta interna segura para redirigir tras el login: solo rutas relativas del mismo origen.
 * Rechaza `//host` y `/\host` (los navegadores los leen como URL relativa al esquema), esquemas,
 * barras invertidas y caracteres de control.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || next.length > 512) return null;
  if (!next.startsWith("/")) return null;
  if (/^\/[/\\]/.test(next)) return null;
  if (/[\\\x00-\x1f\x7f]/.test(next)) return null;
  if (next.startsWith("/login") || next.startsWith("/api/")) return null;
  return next;
}

/** Primera sección del menú a la que el rol tiene acceso (evita aterrizar en /403 tras iniciar sesión). */
export function landingPath(session: StaffSession): string {
  const first = NAV.find((i) => !i.permission || hasPermission(session, i.permission));
  return first?.href ?? "/notificaciones";
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}
