import Image from "next/image";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Iniciar sesión" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");
  const { next } = await searchParams;
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
          <h1 className="mt-3 text-lg font-semibold">Sistema operativo</h1>
          <p className="text-sm text-muted">Accede con tu cuenta de equipo</p>
        </div>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
