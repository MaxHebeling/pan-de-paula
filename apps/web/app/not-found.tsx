import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = {
  title: "Página no encontrada",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="container-x flex flex-col items-center py-20 text-center">
      <Logo size={96} />
      <p className="eyebrow mt-6">Error 404</p>
      <h1 className="display mt-2 text-4xl">Esta página se nos quemó</h1>
      <p className="mt-3 max-w-md text-ink-2">
        No encontramos lo que buscas. Puede que el enlace haya cambiado o que el pedido no exista.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/" className="btn btn-primary">
          Ir al inicio
        </Link>
        <Link href="/menu" className="btn btn-secondary">
          Ver menú
        </Link>
      </div>
    </div>
  );
}
