"use server";
import { z } from "zod";
import { createPasswordReset } from "@pdp/auth";
import { isEmailConfigured, sendEmail } from "@pdp/integrations";
import { db, sql } from "@/lib/db";
import { clientIp } from "@/lib/auth";
import type { ActionState } from "@/lib/action-state";

const schema = z.object({ email: z.string().trim().toLowerCase().email() });

const GENERIC_OK =
  "Si el correo pertenece a una cuenta activa, recibirás un enlace para restablecer tu contraseña. Revisa también la carpeta de spam.";

/**
 * Solicitud de restablecimiento. Responde SIEMPRE igual (exista o no la cuenta) para no revelar correos.
 * Rate limit: máx. 5 solicitudes por IP cada 15 minutos (login_attempts, success=false, email con prefijo).
 */
export async function requestReset(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = schema.safeParse({ email: form.get("email") });
  if (!parsed.success) return { error: "Escribe un correo válido." };
  const ip = await clientIp();
  try {
    if (ip) {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from login_attempts
        where ip = ${ip}::inet and email like 'reset:%' and created_at > now() - interval '15 minutes'`.execute(
        db(),
      );
      if ((r.rows[0]?.n ?? 0) >= 5)
        return { error: "Demasiadas solicitudes. Intenta de nuevo en 15 minutos." };
    }
    await sql`insert into login_attempts(email, ip, success) values (${"reset:" + parsed.data.email}, ${ip}::inet, false)`.execute(
      db(),
    );
    const reset = await createPasswordReset(db(), parsed.data.email);
    if (reset) {
      const base = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:3001").replace(
        /\/+$/,
        "",
      );
      const url = `${base}/restablecer?token=${encodeURIComponent(reset.token)}`;
      if (isEmailConfigured()) {
        const r = await sendEmail({
          to: parsed.data.email,
          subject: "Restablecer contraseña · El Pan de Paula",
          html: `<p>Hola,</p><p>Recibimos una solicitud para restablecer la contraseña de tu cuenta del sistema de El Pan de Paula.</p>
<p><a href="${url}">Crear nueva contraseña</a></p><p>El enlace vence en 1 hora y sirve una sola vez. Si no fuiste tú, ignora este correo.</p>`,
          text: `Restablece tu contraseña (vence en 1 hora): ${url}`,
          idempotencyKey: `reset-${reset.staffId}-${Date.now()}`,
        });
        if (!r.sent)
          console.error(
            "[recuperar] no se pudo enviar el correo de restablecimiento",
            r.error ?? r.skipped,
          );
      } else {
        // Sin proveedor de email configurado: el enlace queda en el log del servidor para que un admin lo comparta.
        console.info(
          `[recuperar] EMAIL NO CONFIGURADO. Enlace de restablecimiento para ${parsed.data.email}: ${url}`,
        );
      }
    }
  } catch (e) {
    console.error("[recuperar] error procesando solicitud", (e as Error).message);
    // Se responde igual: no se filtra si el correo existe ni el detalle del fallo.
  }
  return { ok: GENERIC_OK };
}
