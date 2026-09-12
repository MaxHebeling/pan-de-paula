import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { PageHeader, Card } from "@/components/ui";
import { ProductForm, emptyProduct } from "@/components/catalog/product-form";
import { createProduct } from "../actions";

export const metadata = { title: "Nuevo producto" };
export const dynamic = "force-dynamic";

export default async function NewProductPage({
  searchParams,
}: {
  searchParams: Promise<{ padre?: string }>;
}) {
  await requireSession("catalog.write");
  const { padre } = await searchParams;
  const [categories, parents] = await Promise.all([
    db()
      .selectFrom("categories")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .orderBy("sort_order")
      .orderBy("name")
      .execute(),
    db()
      .selectFrom("products")
      .select(["id", "name"])
      .where("deleted_at", "is", null)
      .where("parent_id", "is", null)
      .orderBy("name")
      .execute(),
  ]);
  const initial =
    padre && parents.some((x) => x.id === padre)
      ? { ...emptyProduct, parent_id: padre }
      : emptyProduct;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Nuevo producto"
        subtitle={
          <Link href="/productos" className="hover:underline">
            ← Productos
          </Link>
        }
      />
      <Card>
        <ProductForm
          action={createProduct}
          categories={categories}
          parents={parents}
          mode="create"
          submitLabel="Crear producto"
          initial={initial}
        />
      </Card>
    </div>
  );
}
