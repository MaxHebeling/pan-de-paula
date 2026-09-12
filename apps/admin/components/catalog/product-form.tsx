"use client";
import { useState } from "react";
import { slugify } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, SubmitButton } from "./action-form";
import { Checkbox, FormGrid, MoneyInput, Select, TextArea, TextInput } from "./fields";

export type ProductFormValues = {
  name: string;
  slug: string;
  sku: string | null;
  short_description: string | null;
  description: string | null;
  category_id: string | null;
  parent_id: string | null;
  variant_label: string | null;
  unit_label: string;
  highlighted_ingredients: string[];
  allergens: string[];
  tags: string[];
  is_active: boolean;
  is_featured: boolean;
  show_on_web: boolean;
  show_on_pos: boolean;
  track_stock: boolean;
  allow_preorder: boolean;
  requires_preorder: boolean;
  pos_favorite: boolean;
  preparation_hours: number | null;
  season_start: string | null;
  season_end: string | null;
  sort_order: number;
};

export const emptyProduct: ProductFormValues = {
  name: "",
  slug: "",
  sku: null,
  short_description: null,
  description: null,
  category_id: null,
  parent_id: null,
  variant_label: null,
  unit_label: "pieza",
  highlighted_ingredients: [],
  allergens: [],
  tags: [],
  is_active: true,
  is_featured: false,
  show_on_web: true,
  show_on_pos: true,
  track_stock: true,
  allow_preorder: true,
  requires_preorder: false,
  pos_favorite: false,
  preparation_hours: null,
  season_start: null,
  season_end: null,
  sort_order: 0,
};

export function ProductForm({
  action,
  initial = emptyProduct,
  categories,
  parents,
  mode,
  submitLabel,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  initial?: ProductFormValues;
  categories: Array<{ id: string; name: string }>;
  parents: Array<{ id: string; name: string }>;
  mode: "create" | "edit";
  submitLabel: string;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [slugTouched, setSlugTouched] = useState(mode === "edit");
  const [parentId, setParentId] = useState(initial.parent_id ?? "");

  return (
    <ActionForm action={action} className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Básicos</h3>
        <FormGrid>
          <TextInput
            label="Nombre"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
          <TextInput
            label="Slug (URL)"
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            hint={mode === "create" ? "Se genera del nombre; puedes ajustarlo." : "Cambiarlo rompe enlaces compartidos."}
          />
          <Select label="Categoría" name="category_id" defaultValue={initial.category_id ?? ""}>
            <option value="">Sin categoría</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <TextInput label="SKU (opcional)" name="sku" maxLength={40} defaultValue={initial.sku ?? ""} />
          <TextInput
            label="Unidad de venta"
            name="unit_label"
            maxLength={30}
            defaultValue={initial.unit_label}
            hint="pieza, paquete, caja…"
          />
          <TextInput label="Orden" name="sort_order" type="number" min={0} defaultValue={initial.sort_order} />
        </FormGrid>
        {mode === "create" && (
          <MoneyInput
            label="Precio regular (MXN)"
            name="price"
            required
            hint="Aplica a tienda y POS. Después podrás fijar precios por canal y promociones."
          />
        )}
        <TextInput
          label="Descripción corta"
          name="short_description"
          maxLength={200}
          defaultValue={initial.short_description ?? ""}
          hint="Una línea para la tarjeta del producto."
        />
        <TextArea label="Descripción" name="description" rows={4} maxLength={2000} defaultValue={initial.description ?? ""} />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Variante</h3>
        <FormGrid>
          <Select
            label="Es variante de"
            name="parent_id"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            hint="Las variantes se agrupan bajo su producto principal (ej. tamaños o sabores)."
          >
            <option value="">No, es un producto principal</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <TextInput
            label="Etiqueta de variante"
            name="variant_label"
            maxLength={40}
            defaultValue={initial.variant_label ?? ""}
            required={Boolean(parentId)}
            disabled={!parentId}
            hint="Ej. Chico, Grande, Nutella"
          />
        </FormGrid>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Detalle</h3>
        <FormGrid cols={3}>
          <TextInput
            label="Ingredientes destacados"
            name="highlighted_ingredients"
            defaultValue={initial.highlighted_ingredients.join(", ")}
            hint="Separados por coma"
          />
          <TextInput label="Alérgenos" name="allergens" defaultValue={initial.allergens.join(", ")} hint="gluten, lácteos, huevo, nuez…" />
          <TextInput label="Etiquetas" name="tags" defaultValue={initial.tags.join(", ")} hint="nuevo, vegano, sin azúcar…" />
        </FormGrid>
        <FormGrid cols={3}>
          <TextInput
            label="Horas de preparación"
            name="preparation_hours"
            type="number"
            min={0}
            max={720}
            defaultValue={initial.preparation_hours ?? ""}
            hint="Para pedidos anticipados"
          />
          <TextInput label="Temporada desde" name="season_start" type="date" defaultValue={initial.season_start ?? ""} />
          <TextInput label="Temporada hasta" name="season_end" type="date" defaultValue={initial.season_end ?? ""} />
        </FormGrid>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Visibilidad y reglas</h3>
        <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
          <Checkbox label="Activo" name="is_active" defaultChecked={initial.is_active} hint="Inactivo: no se vende en ningún canal." />
          <Checkbox label="Destacado" name="is_featured" defaultChecked={initial.is_featured} hint="Aparece en la portada de la tienda." />
          <Checkbox label="Mostrar en tienda web" name="show_on_web" defaultChecked={initial.show_on_web} />
          <Checkbox label="Mostrar en POS" name="show_on_pos" defaultChecked={initial.show_on_pos} />
          <Checkbox label="Favorito en POS" name="pos_favorite" defaultChecked={initial.pos_favorite} hint="Acceso rápido en la pantalla de venta." />
          <Checkbox label="Controlar inventario" name="track_stock" defaultChecked={initial.track_stock} hint="Descuenta existencias al vender." />
          <Checkbox label="Permite pedido anticipado" name="allow_preorder" defaultChecked={initial.allow_preorder} />
          <Checkbox label="Solo bajo pedido" name="requires_preorder" defaultChecked={initial.requires_preorder} hint="No se vende de mostrador." />
        </div>
      </section>

      <div className="flex gap-2">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
