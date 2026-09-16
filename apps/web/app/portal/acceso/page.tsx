import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/portal/session";
import { redeemAccessTokenAction } from "./actions";

export const metadata: Metadata = {
  title: "Entrar a mi cuenta",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PortalAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const token = typeof sp.t === "string" ? sp.t : "";
  if (!token) redirect("/portal/entrar?expirado=1");
  if (await getCustomerSession()) redirect("/portal");

  return (
    <div className="container-x max-w-md py-14 sm:py-20">
      <div className="card p-6 text-center sm:p-8">
        <p className="eyebrow">Club El Pan de Paula</p>
        <h1 className="display mt-2 text-3xl">Ya casi</h1>
        <p className="mt-3 text-ink-2">
          Toca el botón para entrar a tu cuenta. Este enlace sirve una sola vez.
        </p>
        <form action={redeemAccessTokenAction} className="mt-6">
          <input type="hidden" name="t" value={token} />
          <button
            type="submit"
            className="btn btn-primary btn-lg w-full"
            data-testid="portal-acceso-confirmar"
          >
            Entrar a mi cuenta
          </button>
        </form>
      </div>
    </div>
  );
}
