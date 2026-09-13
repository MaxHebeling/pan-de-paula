import Image from "next/image";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/catalog/action-form";
import { TextInput } from "@/components/catalog/fields";
import { resetPassword } from "./actions";

export const metadata = { title: "Nueva contraseña" };
export const dynamic = "force-dynamic";

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="card card-lg w-full max-w-sm p-6 md:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Image
            src="/logo.png"
            alt="El Pan de Paula"
            width={72}
            height={72}
            className="rounded-full"
            priority
          />
          <h1 className="mt-3 text-lg font-semibold">Nueva contraseña</h1>
          <p className="text-sm text-muted">Mínimo 10 caracteres, con letras y números.</p>
        </div>
        {!token ? (
          <div className="st-amber rounded-[var(--r-card)] px-4 py-3 text-sm">
            Falta el token del enlace.{" "}
            <Link href="/recuperar" className="underline">
              Solicita uno nuevo
            </Link>
            .
          </div>
        ) : (
          <ActionForm action={resetPassword} className="flex flex-col gap-3">
            <input type="hidden" name="token" value={token} />
            <TextInput
              label="Nueva contraseña"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
            />
            <TextInput
              label="Confirmar contraseña"
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
            />
            <SubmitButton size="lg" pendingText="Guardando…">
              Guardar contraseña
            </SubmitButton>
          </ActionForm>
        )}
        <Link href="/login" className="mt-4 block text-center text-sm text-teal-d hover:underline">
          Volver a iniciar sesión
        </Link>
      </div>
    </main>
  );
}
