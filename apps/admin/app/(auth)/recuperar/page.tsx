import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ActionForm, SubmitButton } from "@/components/catalog/action-form";
import { TextInput } from "@/components/catalog/fields";
import { requestReset } from "./actions";

export const metadata = { title: "Recuperar contraseña" };
export const dynamic = "force-dynamic";

export default async function RecoverPage() {
  if (await getSession()) redirect("/dashboard");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="card card-lg w-full max-w-sm p-6 md:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <Image
            src="/logo.jpeg"
            alt="El Pan de Paula"
            width={72}
            height={72}
            className="rounded-full"
            priority
          />
          <h1 className="mt-3 text-lg font-semibold">Recuperar contraseña</h1>
          <p className="text-sm text-muted">Te enviaremos un enlace para crear una nueva.</p>
        </div>
        <ActionForm action={requestReset} className="flex flex-col gap-3" resetOnSuccess>
          <TextInput
            label="Correo"
            name="email"
            type="email"
            required
            autoComplete="username"
            inputMode="email"
          />
          <SubmitButton size="lg" pendingText="Enviando…">
            Enviar enlace
          </SubmitButton>
        </ActionForm>
        <Link href="/login" className="mt-4 block text-center text-sm text-teal-d hover:underline">
          Volver a iniciar sesión
        </Link>
      </div>
    </main>
  );
}
