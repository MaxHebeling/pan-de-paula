import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_DAYS,
  resolveCustomerSession,
  type CustomerSession,
} from "@pdp/auth/customer";
import { db } from "@/lib/db";

export { CUSTOMER_SESSION_COOKIE, CUSTOMER_SESSION_TTL_DAYS };
export type { CustomerSession };

/**
 * Sesión del cliente a partir de la cookie httpOnly (cacheada por petición).
 * Es la ÚNICA fuente de identidad del portal: ningún parámetro de la URL decide de quién son los datos.
 */
export const getCustomerSession = cache(async (): Promise<CustomerSession | null> => {
  const jar = await cookies();
  return resolveCustomerSession(db(), jar.get(CUSTOMER_SESSION_COOKIE)?.value);
});

/** Exige sesión de cliente; sin ella redirige a /portal/entrar. */
export async function requireCustomerSession(): Promise<CustomerSession> {
  const s = await getCustomerSession();
  if (!s) redirect("/portal/entrar");
  return s;
}

/** Cookie de sesión: httpOnly, sameSite lax y `secure` en producción (mismo criterio que el staff). */
export function customerSessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** User-Agent recortado para dejar constancia de en qué dispositivo se abrió la sesión. */
export async function currentUserAgent(): Promise<string | null> {
  const h = await headers();
  return h.get("user-agent")?.slice(0, 512) ?? null;
}
