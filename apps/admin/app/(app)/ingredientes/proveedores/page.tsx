import Link from "next/link";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { PageHeader, Card, Badge, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/catalog/action-form";
import { Checkbox, FormGrid, TextArea, TextInput } from "@/components/catalog/fields";
import { createSupplier, updateSupplier } from "../actions";

export const metadata = { title: "Proveedores" };
export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const session = await requireSession("recipes.read");
  const canWrite = hasPermission(session, "recipes.write");
  const rows = await db()
    .selectFrom("suppliers as s")
    .selectAll("s")
    .select(
      sql<number>`(select count(*)::int from ingredients i where i.supplier_id = s.id and i.deleted_at is null)`.as(
        "ingredients",
      ),
    )
    .orderBy("s.is_active", "desc")
    .orderBy("s.name")
    .execute();

  return (
    <>
      <PageHeader
        title="Proveedores"
        subtitle={
          <Link href="/ingredientes" className="hover:underline">
            ← Ingredientes
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          {rows.length === 0 ? (
            <EmptyState
              title="Sin proveedores"
              body="Registra a quién le compras para llevar historial de precios por proveedor."
            />
          ) : (
            rows.map((s) => (
              <details key={s.id} className="card group p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 text-xs text-muted">
                      {[s.contact, s.phone, s.email].filter(Boolean).join(" · ") ||
                        "sin datos de contacto"}{" "}
                      · {s.ingredients} insumo
                      {s.ingredients === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="flex items-center gap-2">
                    <Badge tone={s.is_active ? "green" : "gray"}>
                      {s.is_active ? "Activo" : "Inactivo"}
                    </Badge>
                    {canWrite && (
                      <span className="text-xs text-teal-d group-open:hidden">Editar</span>
                    )}
                  </span>
                </summary>
                {canWrite && (
                  <ActionForm
                    action={updateSupplier.bind(null, s.id)}
                    className="mt-4 flex flex-col gap-3 border-t border-line pt-4"
                  >
                    <FormGrid>
                      <TextInput
                        label="Nombre"
                        name="name"
                        required
                        maxLength={80}
                        defaultValue={s.name}
                        id={`name-${s.id}`}
                      />
                      <TextInput
                        label="Contacto"
                        name="contact"
                        maxLength={80}
                        defaultValue={s.contact ?? ""}
                        id={`contact-${s.id}`}
                      />
                      <TextInput
                        label="Teléfono"
                        name="phone"
                        maxLength={30}
                        defaultValue={s.phone ?? ""}
                        id={`phone-${s.id}`}
                      />
                      <TextInput
                        label="Email"
                        name="email"
                        type="email"
                        defaultValue={s.email ?? ""}
                        id={`email-${s.id}`}
                      />
                    </FormGrid>
                    <TextArea
                      label="Notas"
                      name="notes"
                      rows={2}
                      maxLength={500}
                      defaultValue={s.notes ?? ""}
                      id={`notes-${s.id}`}
                    />
                    <Checkbox
                      label="Activo"
                      name="is_active"
                      defaultChecked={s.is_active}
                      id={`active-${s.id}`}
                    />
                    <div>
                      <SubmitButton size="sm">Guardar</SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </details>
            ))
          )}
        </div>
        {canWrite && (
          <Card title="Nuevo proveedor">
            <ActionForm action={createSupplier} resetOnSuccess className="flex flex-col gap-3">
              <TextInput label="Nombre" name="name" required maxLength={80} />
              <TextInput label="Contacto" name="contact" maxLength={80} />
              <FormGrid>
                <TextInput label="Teléfono" name="phone" maxLength={30} inputMode="tel" />
                <TextInput label="Email" name="email" type="email" />
              </FormGrid>
              <TextArea label="Notas" name="notes" rows={2} maxLength={500} />
              <Checkbox label="Activo" name="is_active" defaultChecked />
              <SubmitButton pendingText="Creando…">Crear proveedor</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
