import Link from "next/link";
import { db, sql } from "@/lib/db";
import { requireSession, hasPermission } from "@/lib/auth";

import { PageHeader, Card, Table, Badge, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton, ConfirmButton } from "@/components/catalog/action-form";
import { TextInput, TextArea, Checkbox, FormGrid } from "@/components/catalog/fields";
import { createCategory, moveCategory, toggleCategory } from "./actions";

export const metadata = { title: "Categorías" };
export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const session = await requireSession("catalog.read");
  const canWrite = hasPermission(session, "catalog.write");
  const rows = await db()
    .selectFrom("categories as c")
    .select([
      "c.id",
      "c.name",
      "c.slug",
      "c.description",
      "c.image_url",
      "c.sort_order",
      "c.is_active",
      sql<number>`(select count(*)::int from products p where p.category_id = c.id and p.deleted_at is null)`.as(
        "products",
      ),
    ])
    .where("c.deleted_at", "is", null)
    .orderBy("c.sort_order")
    .orderBy("c.name")
    .execute();

  return (
    <>
      <PageHeader
        title="Categorías"
        subtitle="Orden en que aparecen en la tienda y el POS. Arrástralas con las flechas."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          {rows.length === 0 ? (
            <EmptyState
              title="Sin categorías"
              body="Crea la primera categoría para organizar el catálogo."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Categoría</th>
                  <th className="text-right">Productos</th>
                  <th>Estado</th>
                  {canWrite && <th className="text-right">Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((c, i) => (
                  <tr key={c.id}>
                    <td className="tabular-nums text-muted">{i + 1}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        {c.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.image_url}
                            alt=""
                            className="size-10 rounded-lg object-cover"
                          />
                        ) : (
                          <div className="size-10 rounded-lg bg-black/5" aria-hidden />
                        )}
                        <div>
                          <Link
                            href={`/categorias/${c.id}`}
                            className="font-medium hover:underline"
                          >
                            {c.name}
                          </Link>
                          <div className="text-xs text-muted">/{c.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{c.products}</td>
                    <td>
                      <Badge tone={c.is_active ? "green" : "gray"}>
                        {c.is_active ? "Activa" : "Inactiva"}
                      </Badge>
                    </td>
                    {canWrite && (
                      <td>
                        <div className="flex justify-end gap-1">
                          <form action={moveCategory.bind(null, c.id, "up")}>
                            <ConfirmButton title="Subir" className={i === 0 ? "invisible" : ""}>
                              ↑
                            </ConfirmButton>
                          </form>
                          <form action={moveCategory.bind(null, c.id, "down")}>
                            <ConfirmButton
                              title="Bajar"
                              className={i === rows.length - 1 ? "invisible" : ""}
                            >
                              ↓
                            </ConfirmButton>
                          </form>
                          <form action={toggleCategory.bind(null, c.id, !c.is_active)}>
                            <ConfirmButton>{c.is_active ? "Desactivar" : "Activar"}</ConfirmButton>
                          </form>
                          <Link href={`/categorias/${c.id}`} className="btn btn-secondary btn-sm">
                            Editar
                          </Link>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        {canWrite && (
          <Card title="Nueva categoría">
            <ActionForm action={createCategory} resetOnSuccess className="flex flex-col gap-3">
              <TextInput label="Nombre" name="name" required maxLength={80} autoComplete="off" />
              <TextInput
                label="Slug (opcional)"
                name="slug"
                hint="Se genera del nombre si lo dejas vacío."
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
              />
              <TextArea label="Descripción" name="description" maxLength={500} rows={2} />
              <FormGrid>
                <TextInput
                  label="Orden"
                  name="sort_order"
                  type="number"
                  min={0}
                  defaultValue={rows.length + 1}
                />
                <TextInput
                  label="Imagen"
                  name="image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/avif"
                />
              </FormGrid>
              <Checkbox label="Activa" name="is_active" defaultChecked />
              <SubmitButton pendingText="Creando…">Crear categoría</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
