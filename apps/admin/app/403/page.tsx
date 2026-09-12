import Link from "next/link";
export default function Forbidden() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-2xl font-semibold">Sin permiso</h1>
      <p className="text-muted">
        Tu rol no tiene acceso a esta sección. Pide a un administrador que lo habilite.
      </p>
      <Link href="/dashboard" className="btn btn-primary">
        Volver al inicio
      </Link>
    </main>
  );
}
