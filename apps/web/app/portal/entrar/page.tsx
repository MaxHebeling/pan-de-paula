import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/portal/session";
import { PortalLoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Entrar a mi cuenta",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await getCustomerSession()) redirect("/portal");
  const sp = await searchParams;
  const notice =
    sp.expirado === "1"
      ? "Ese enlace ya no sirve: caduca en una hora y solo se puede usar una vez. Pide uno nuevo aquí."
      : sp.salir === "1"
        ? "Cerraste tu sesión. Cuando quieras volver, pídete un enlace nuevo."
        : null;

  return (
    <div className="container-x max-w-xl py-10 sm:py-14">
      <p className="eyebrow mb-2">Club El Pan de Paula</p>
      <h1 className="display text-4xl sm:text-5xl">Entra a tu cuenta</h1>
      <p className="mt-4 text-lg text-ink-2">
        Consulta tus puntos, tu nivel, tu QR y todas tus compras. Te enviamos un enlace a tu correo:
        sin contraseñas que recordar.
      </p>
      {notice && (
        <p
          className="mt-6 rounded-card border border-crust/50 bg-crust/10 px-4 py-3 text-sm text-ink"
          role="status"
          data-testid="portal-notice"
        >
          {notice}
        </p>
      )}
      <div className="mt-8">
        <PortalLoginForm />
      </div>
      <p className="mt-8 text-sm text-ink-2">
        ¿Todavía no tienes tarjeta?{" "}
        <Link href="/unete" className="text-sage underline">
          Únete al club
        </Link>
        .
      </p>
    </div>
  );
}
