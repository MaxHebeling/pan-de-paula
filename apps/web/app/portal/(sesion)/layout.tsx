import type { Metadata } from "next";
import { LogoutButton } from "@/components/portal/LogoutButton";
import { PortalNav } from "@/components/portal/PortalNav";
import { countUnreadNotifications } from "@/lib/portal/orders";
import { requireCustomerSession } from "@/lib/portal/session";
import { portalLogoutAction } from "./actions";

export const metadata: Metadata = {
  title: "Mi cuenta",
  robots: { index: false, follow: false },
};

/** El portal lee la sesión en cada petición: nada se cachea ni se prerrenderiza. */
export const dynamic = "force-dynamic";

/**
 * Puerta única del portal: todas las páginas de `(sesion)` pasan por aquí, así que ninguna puede
 * quedarse sin comprobar la sesión por olvido. Sin cookie válida → /portal/entrar.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCustomerSession();
  const firstName = session.customer.fullName.split(/\s+/)[0] ?? session.customer.fullName;
  const sinLeer = await countUnreadNotifications(session.customer.id);

  return (
    <div className="container-x max-w-3xl py-8 sm:py-12">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="eyebrow">Mi cuenta</p>
          <p className="truncate font-display text-xl text-ink" data-testid="portal-greeting">
            Hola, {firstName}
          </p>
        </div>
        {/* Cerrar sesión apaga antes los avisos de ESTE dispositivo: una suscripción viva
            seguiría recibiendo los pedidos de quien ya se fue. */}
        <LogoutButton action={portalLogoutAction} />
      </header>
      <div className="mt-5">
        <PortalNav sinLeer={sinLeer} />
      </div>
      <div className="mt-7">{children}</div>
    </div>
  );
}
