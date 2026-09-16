"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { consumeCustomerAccessToken } from "@pdp/auth/customer";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  CUSTOMER_SESSION_COOKIE,
  currentUserAgent,
  customerSessionCookieOptions,
} from "@/lib/portal/session";

/**
 * Canjea el enlace de acceso y abre la sesión.
 *
 * Va en una acción POST (no en un GET) a propósito: los clientes de correo y los antivirus
 * "pre-visitan" los enlaces, y con un GET el token se habría consumido antes de que el cliente
 * tocara nada. El canje es de un solo uso y está limitado por IP.
 */
export async function redeemAccessTokenAction(formData: FormData): Promise<void> {
  const token = String(formData.get("t") ?? "");
  const rl = await rateLimit("portal-acceso", { max: 12 });
  if (!rl.allowed) redirect("/portal/entrar?expirado=1");

  const ip = await clientIp();
  const userAgent = await currentUserAgent();
  const result = await consumeCustomerAccessToken(db(), token, { ip, userAgent });
  if (!result) redirect("/portal/entrar?expirado=1");

  const jar = await cookies();
  jar.set(
    CUSTOMER_SESSION_COOKIE,
    result.token,
    customerSessionCookieOptions(result.session.expiresAt),
  );
  redirect("/portal?bienvenida=1");
}
