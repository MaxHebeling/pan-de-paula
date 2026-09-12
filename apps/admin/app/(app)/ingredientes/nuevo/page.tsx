import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { PageHeader, Card } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/catalog/action-form";
import { Checkbox, FormGrid, MoneyInput, Select, TextArea, TextInput } from "@/components/catalog/fields";
import { createIngredient } from "../actions";

export const metadata = { title: "Nuevo ingrediente" };
export const dynamic = "force-dynamic";

export default async function NewIngredientPage() {
  await requireSession("recipes.write");
  const suppliers = await db().selectFrom("suppliers").select(["id", "name"]).where("is_active", "=", true).orderBy("name").execute();
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Nuevo ingrediente"
        subtitle={
          <Link href="/ingredientes" className="hover:underline">
            ← Ingredientes
          </Link>
        }
      />
      <Card>
        <ActionForm action={createIngredient} className="flex min-w-0 flex-col gap-4">
          <FormGrid>
            <TextInput label="Nombre" name="name" required maxLength={80} placeholder="Harina de trigo" />
            <TextInput label="Marca (opcional)" name="brand" maxLength={60} />
            <Select
              label="Unidad base"
              name="base_unit"
              defaultValue="g"
              hint="Todas las recetas y costos de este insumo se miden en esta unidad."
            >
              <option value="g">gramos (g) — sólidos</option>
              <option value="ml">mililitros (ml) — líquidos</option>
              <option value="pz">piezas (pz) — huevo, empaques…</option>
            </Select>
            <Select label="Proveedor" name="supplier_id" defaultValue="">
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <TextInput label="Stock mínimo (en unidad base)" name="min_stock_qty" type="number" step="any" min={0} defaultValue={0} hint="Para la alerta de reposición." />
          </FormGrid>
          <TextArea label="Notas" name="notes" rows={2} maxLength={500} />
          <Checkbox label="Disponible" name="is_available" defaultChecked hint="Desmárcalo si dejó de conseguirse." />

          <fieldset className="rounded-[var(--r-card)] border border-line p-4">
            <legend className="px-1 text-sm font-semibold">Precio de compra inicial (opcional)</legend>
            <p className="mb-3 text-xs text-muted">
              Precio pagado y contenido del empaque. El sistema calcula el costo por unidad base. Puedes usar kg / L / docena: se convierte
              automáticamente.
            </p>
            <FormGrid cols={4}>
              <MoneyInput label="Precio (MXN)" name="price" />
              <TextInput label="Contenido" name="qty" type="number" step="any" min={0} />
              <Select label="Unidad" name="unit" defaultValue="">
                <option value="">= unidad base</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="lb">lb</option>
                <option value="oz">oz</option>
                <option value="ml">ml</option>
                <option value="l">L</option>
                <option value="pz">pz</option>
                <option value="docena">docena</option>
              </Select>
              <TextInput label="Presentación" name="package_label" maxLength={80} placeholder="Bolsa 1 kg" />
            </FormGrid>
          </fieldset>
          <div>
            <SubmitButton pendingText="Creando…">Crear ingrediente</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
