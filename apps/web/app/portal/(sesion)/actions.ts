"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logoutCustomer } from "@pdp/auth/customer";
import { db } from "@/lib/db";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/portal/session";

/** Cierra la sesión: revoca el token en la base (no basta con borrar la cookie) y deja rastro. */
export async function portalLogoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(CUSTOMER_SESSION_COOKIE)?.value;
  try {
    await logoutCustomer(db(), token);
  } catch (e) {
    console.error("[portal] no se pudo revocar la sesión", e);
  }
  jar.delete(CUSTOMER_SESSION_COOKIE);
  redirect("/portal/entrar?salir=1");
}
