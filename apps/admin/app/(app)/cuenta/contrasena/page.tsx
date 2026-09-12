import { PageHeader, Card, Alert } from "@/components/ui";
import { PasswordForm } from "./form";

export const metadata = { title: "Cambiar contraseña" };

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ forzado?: string }>;
}) {
  const { forzado } = await searchParams;
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Cambiar contraseña" subtitle="Mínimo 10 caracteres, letras y números." />
      {forzado && (
        <div className="mb-4">
          <Alert tone="amber">Por seguridad debes cambiar tu contraseña antes de continuar.</Alert>
        </div>
      )}
      <Card>
        <PasswordForm />
      </Card>
    </div>
  );
}
