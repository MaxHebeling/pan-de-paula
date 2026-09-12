import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { PageHeader, Card, LinkButton } from "@/components/ui";
import { CustomerForm } from "@/components/customers/customer-form";
import { getCustomer } from "@/lib/customers";
import { updateCustomerAction } from "../../actions";

export const metadata = { title: "Editar cliente" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession("customers.write");
  const { id } = await params;
  const c = await getCustomer(id);
  if (!c || c.deleted_at) notFound();
  return (
    <>
      <PageHeader
        title={`Editar · ${c.full_name}`}
        subtitle={c.public_code}
        actions={
          <LinkButton href={`/clientes/${c.id}`} variant="secondary">
            Cancelar
          </LinkButton>
        }
      />
      <Card>
        <CustomerForm action={updateCustomerAction} values={c} submitLabel="Guardar cambios" />
      </Card>
    </>
  );
}
