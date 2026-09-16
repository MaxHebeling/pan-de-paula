import "server-only";
import { isEmailConfigured, sendPortalAccessEmail } from "@pdp/integrations";

/** URL absoluta del enlace de acceso al portal. El token viaja en la query, nunca en la ruta. */
export function portalAccessUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${base}/portal/acceso?t=${encodeURIComponent(token)}`;
}

/**
 * Envía el enlace de acceso por correo (Resend, con el maquetado común de @pdp/integrations).
 * Devuelve false si el proveedor no está configurado — es el caso HOY en producción: mientras tanto el
 * enlace se genera desde la ficha del cliente en el CRM y el equipo se lo comparte.
 * Nunca lanza: el portal responde siempre igual, exista o no la cuenta.
 */
export async function sendPortalLink(input: {
  to: string;
  firstName: string;
  businessName: string;
  link: string;
  minutes: number;
}): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    const r = await sendPortalAccessEmail(input.to, {
      businessName: input.businessName,
      firstName: input.firstName,
      link: input.link,
      minutes: input.minutes,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    });
    return Boolean(r.sent);
  } catch (e) {
    console.error("[portal] no se pudo enviar el enlace de acceso", e);
    return false;
  }
}
