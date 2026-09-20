import Link from "next/link";
import { NotificationPrefs } from "@/components/portal/NotificationPrefs";
import { env } from "@/lib/env";
import { getCustomerPrefs } from "@/lib/portal/orders";
import { requireCustomerSession } from "@/lib/portal/session";

export const metadata = {
  title: "Ajustes de avisos",
  robots: { index: false, follow: false },
};

export default async function PortalPrefsPage() {
  const session = await requireCustomerSession();
  const prefs = await getCustomerPrefs(session.customer.id);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/portal/avisos" className="text-sm text-ink-2 underline">
          ← Avisos
        </Link>
        <h1 className="mt-2 font-display text-2xl text-ink">Qué avisos quieres recibir</h1>
      </div>
      <NotificationPrefs
        inicial={prefs}
        vapidPublicKey={env().NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null}
      />
    </div>
  );
}
