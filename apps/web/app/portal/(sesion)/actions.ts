"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logoutCustomer } from "@pdp/auth/customer";
import { birthdaySchema, parsePhone } from "@pdp/domain";
import { db, sql } from "@/lib/db";
import { CUSTOMER_SESSION_COOKIE, requireCustomerSession } from "@/lib/portal/session";

export type PortalProfileState = { ok?: string; error?: string; field?: string } | null;

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

/**
 * El cliente completa desde su portal los datos que le faltan: celular y fecha de nacimiento.
 *
 * Solo RELLENA huecos de su PROPIA cuenta (el id sale de la sesión, nunca del formulario) y nunca
 * pisa un dato que ya tenía: corregir algo existente se pide al equipo, que lo cambia desde el CRM
 * con su auditoría. El correo no se toca aquí: es la llave de acceso y cambiarlo sin verificar el
 * nuevo buzón dejaría a alguien fuera de su cuenta.
 */
export async function completePortalProfileAction(
  _prev: PortalProfileState,
  fd: FormData,
): Promise<PortalProfileState> {
  const session = await requireCustomerSession();
  const actual = await sql<{ phone: string | null; birthday: string | null }>`
    select phone::text as phone, to_char(birthday, 'YYYY-MM-DD') as birthday
      from customers where id = ${session.customer.id} and deleted_at is null`.execute(db());
  const row = actual.rows[0];
  if (!row) return { error: "No pudimos leer tu cuenta. Inténtalo más tarde." };

  let phone: string | null = null;
  if (!row.phone) {
    const parsed = parsePhone(String(fd.get("phone_country") ?? ""), String(fd.get("phone") ?? ""));
    if (!parsed.ok) return { error: parsed.error, field: "phone" };
    if (!parsed.value) return { error: "Escribe tu celular.", field: "phone" };
    phone = parsed.value;
  }
  let birthday: string | null = null;
  if (!row.birthday) {
    const parsed = birthdaySchema.safeParse(String(fd.get("birthday") ?? ""));
    if (!parsed.success)
      return { error: parsed.error.issues[0]?.message ?? "Revisa la fecha.", field: "birthday" };
    birthday = parsed.data;
  }
  if (!phone && !birthday) return { ok: "Tus datos ya estaban completos." };

  try {
    await sql`update customers
                 set phone = coalesce(phone, ${phone}), birthday = coalesce(birthday, ${birthday}::date)
               where id = ${session.customer.id} and deleted_at is null`.execute(db());
  } catch (e) {
    // Otro cliente ya tiene ese teléfono: no se revela de quién es.
    if ((e as { code?: string }).code === "23505")
      return { error: "Ese celular ya está registrado en otra cuenta.", field: "phone" };
    console.error("[portal] no se pudieron completar los datos", e);
    return { error: "No pudimos guardar tus datos. Inténtalo más tarde." };
  }
  revalidatePath("/portal/perfil");
  revalidatePath("/portal");
  return { ok: "Listo, ya quedaron tus datos." };
}
