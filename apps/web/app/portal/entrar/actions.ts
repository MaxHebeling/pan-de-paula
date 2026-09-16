"use server";

import { createCustomerAccessToken, findCustomerByEmail } from "@pdp/auth/customer";
import { requiredEmailSchema } from "@pdp/domain";
import { clientIp, rateLimit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { portalAccessUrl, sendPortalLink } from "@/lib/portal/link";
import { getBusiness } from "@/lib/site";

export type PortalLoginState = {
  error?: string;
  /** Acuse genérico: se muestra EXISTA O NO la cuenta (no se revela qué correos están registrados). */
  sent?: boolean;
  email?: string;
} | null;

/**
 * Pide un enlace de acceso al portal.
 *
 * Privacidad: la respuesta es idéntica exista o no la cuenta, y tarda lo mismo en apariencia (no hay
 * ramas visibles para el visitante). Nunca se dice si un correo está registrado ni si el envío salió.
 * Rate limit por IP sobre la misma tabla `rate_limits` del resto del sitio (migración 0050).
 */
export async function requestPortalLinkAction(
  _prev: PortalLoginState,
  formData: FormData,
): Promise<PortalLoginState> {
  const raw = String(formData.get("email") ?? "");
  const parsed = requiredEmailSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Revisa tu correo.", email: raw };
  }
  const email = parsed.data;
  try {
    // Ventana de 10 min: 8 solicitudes por IP. Más estricto que el registro porque cada acierto
    // manda un correo real.
    const rl = await rateLimit("portal-entrar", { max: 8 });
    if (!rl.allowed) return { error: RATE_LIMIT_MESSAGE, email: raw };

    const customer = await findCustomerByEmail(db(), email);
    if (customer) {
      const ip = await clientIp();
      const { token, expiresAt } = await createCustomerAccessToken(db(), {
        customerId: customer.id,
        requestedBy: "self",
        ip,
      });
      const link = portalAccessUrl(token);
      const business = await getBusiness();
      const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
      const sent = await sendPortalLink({
        to: customer.email,
        firstName: customer.fullName.split(/\s+/)[0] ?? customer.fullName,
        businessName: business.name,
        link,
        minutes,
      });
      if (!sent) {
        // Sin proveedor de correo configurado el enlace existe pero no sale de aquí: el equipo puede
        // regenerarlo desde la ficha del cliente en el CRM. Nunca se devuelve al navegador.
        console.warn(
          `[portal] enlace de acceso generado para ${customer.id} pero no se pudo enviar por correo`,
        );
      }
    } else {
      console.info("[portal] solicitud de enlace para un correo sin cuenta; respuesta genérica");
    }
  } catch (e) {
    console.error("[portal] solicitud de enlace falló", e);
    return { error: "No pudimos procesar tu solicitud. Inténtalo de nuevo en un momento." };
  }
  return { sent: true, email };
}
