import { requireSession } from "@/lib/auth";
import { PageHeader, Card, LinkButton } from "@/components/ui";
import { CustomerForm } from "@/components/customers/customer-form";
import { createCustomerAction } from "../actions";

export const metadata = { title: "Nuevo cliente" };

export default async function NewCustomerPage() {
  await requireSession("customers.write");
  return (
    <>
      <PageHeader
        title="Nuevo cliente"
        subtitle="Alta manual desde el CRM. El cliente también puede registrarse por QR en mostrador."
        actions={
          <LinkButton href="/clientes" variant="secondary">
            Volver
          </LinkButton>
        }
      />
      <Card>
        <CustomerForm action={createCustomerAction} submitLabel="Registrar cliente" />
      </Card>
    </>
  );
}
