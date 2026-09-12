import { notFound } from "next/navigation";
import Link from "next/link";
import { db, sql } from "@/lib/db";
import { requireSession } from "@/lib/auth";

import { PageHeader, Card, Alert, LinkButton } from "@/components/ui";
import { ActionForm, SubmitButton, ConfirmButton } from "@/components/catalog/action-form";
import { TextInput, TextArea, Checkbox, FormGrid } from "@/components/catalog/fields";
import { deleteCategory, updateCategory } from "../actions";

export const metadata = { title: "Editar categoría" };
export const dynamic = "force-dynamic";

export default async function CategoryEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireSession("catalog.write");
  const { id } = await params;
  const { error } = await searchParams;
  const c = await db()
    .selectFrom("categories as c")
    .selectAll("c")
    .select(
      sql<number>`(select count(*)::int from products p where p.category_id = c.id and p.deleted_at is null)`.as(
        "products",
      ),
    )
    .where("c.id", "=", id)
    .where("c.deleted_at", "is", null)
    .executeTakeFirst();
  if (!c) notFound();
  const update = updateCategory.bind(null, c.id);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={c.name}
        subtitle={
          <>
            <Link href="/categorias" className="hover:underline">
              Categorías
            </Link>{" "}
            · {c.products} producto{c.products === 1 ? "" : "s"}
          </>
        }
        actions={
          <LinkButton href={`/productos?categoria=${c.id}`} variant="secondary">
            Ver productos
          </LinkButton>
        }
      />
      {error === "en-uso" && (
        <div className="mb-4">
          <Alert tone="amber">
            No se puede eliminar: tiene productos asignados. Mueve o elimina los productos primero.
          </Alert>
        </div>
      )}
      <Card>
        <ActionForm action={update} className="flex flex-col gap-3">
          <FormGrid>
            <TextInput label="Nombre" name="name" required maxLength={80} defaultValue={c.name} />
            <TextInput
              label="Slug"
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              defaultValue={c.slug}
              hint="Cambiarlo rompe enlaces ya compartidos."
            />
          </FormGrid>
          <TextArea
            label="Descripción"
            name="description"
            maxLength={500}
            rows={3}
            defaultValue={c.description ?? ""}
          />
          <FormGrid>
            <TextInput
              label="Orden"
              name="sort_order"
              type="number"
              min={0}
              defaultValue={c.sort_order}
            />
            <TextInput
              label={c.image_url ? "Reemplazar imagen" : "Imagen"}
              name="image"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
            />
          </FormGrid>
          {c.image_url && (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={c.image_url}
                alt={`Imagen de ${c.name}`}
                className="size-20 rounded-lg object-cover"
              />
              <Checkbox label="Quitar imagen" name="remove_image" />
            </div>
          )}
          <Checkbox
            label="Activa"
            name="is_active"
            defaultChecked={c.is_active}
            hint="Inactiva: no aparece en tienda ni POS."
          />
          <div className="flex gap-2">
            <SubmitButton>Guardar cambios</SubmitButton>
            <LinkButton href="/categorias" variant="secondary">
              Volver
            </LinkButton>
          </div>
        </ActionForm>
      </Card>
      <Card title="Zona de riesgo" className="mt-4">
        <p className="mb-3 text-sm text-muted">
          Eliminar la categoría la oculta de todos lados. Solo es posible si no tiene productos.
        </p>
        <form action={deleteCategory.bind(null, c.id)}>
          <ConfirmButton variant="danger" size="sm" confirm={`¿Eliminar la categoría "${c.name}"?`}>
            Eliminar categoría
          </ConfirmButton>
        </form>
      </Card>
    </div>
  );
}
