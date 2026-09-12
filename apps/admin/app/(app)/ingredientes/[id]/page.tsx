import Link from "next/link";
import { notFound } from "next/navigation";
import { formatQty, priceChangePct, type BaseUnit } from "@pdp/domain";
import { requireSession, hasPermission } from "@/lib/auth";
import { db, sql } from "@/lib/db";
import { fmtDate, qty as fmtQty } from "@/lib/format";
import { PageHeader, Card, Alert, Badge, Money, Stat, Table, LinkButton } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/catalog/action-form";
import { Checkbox, FormGrid, Select, TextArea, TextInput } from "@/components/catalog/fields";
import { IngredientPriceForm, type IngredientUsage } from "@/components/catalog/ingredient-price-form";
import { PURCHASE_UNITS, formatUnitCost } from "@/components/catalog/units";
import { deleteIngredient, recordIngredientMovement, recordIngredientPrice, updateIngredient } from "../actions";

export const dynamic = "force-dynamic";

const MOVEMENT_LABEL: Record<string, string> = {
  PURCHASE: "Compra",
  CONSUMPTION: "Consumo",
  WASTE: "Merma",
  CORRECTION: "Corrección",
  INITIAL: "Inicial",
};

export default async function IngredientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ creado?: string; error?: string }>;
}) {
  const session = await requireSession("recipes.read");
  const canWrite = hasPermission(session, "recipes.write");
  const { id } = await params;
  const sp = await searchParams;
  const ing = await db().selectFrom("ingredients").selectAll().where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  if (!ing) notFound();
  const base = ing.base_unit as BaseUnit;

  const [suppliers, prices, movements, usagesRes, unitCostRes] = await Promise.all([
    db().selectFrom("suppliers").select(["id", "name"]).where("is_active", "=", true).orderBy("name").execute(),
    sql<{
      id: string;
      valid_from: Date;
      package_label: string | null;
      package_qty: string;
      price_cents: number;
      unit_cost: string;
      source: string;
      supplier_name: string | null;
      created_by_name: string | null;
    }>`select p.id, p.valid_from, p.package_label, p.package_qty, p.price_cents, p.unit_cost, p.source, s.name as supplier_name, u.full_name as created_by_name
       from ingredient_prices p left join suppliers s on s.id = p.supplier_id left join staff_users u on u.id = p.created_by
       where p.ingredient_id = ${id} order by p.valid_from desc, p.created_at desc limit 100`.execute(db()),
    sql<{ id: number; type: string; qty: string; note: string | null; occurred_at: Date; staff_name: string | null; ref_type: string | null }>`
      select m.id, m.type, m.qty, m.note, m.occurred_at, u.full_name as staff_name, m.ref_type
      from ingredient_movements m left join staff_users u on u.id = m.staff_id
      where m.ingredient_id = ${id} order by m.occurred_at desc, m.id desc limit 30`.execute(db()),
    sql<IngredientUsage>`
      select r.product_id, p.name as product_name, r.yield_qty::float8 as yield_qty, r.labor_cents, r.overhead_cents,
             coalesce((select sum(o.qty * coalesce(ingredient_unit_cost(o.ingredient_id), 0)) from recipe_items o where o.recipe_id = r.id and o.ingredient_id <> ${id}), 0)::float8 as other_cost,
             ri.qty::float8 as qty_this,
             product_cost_cents(r.product_id) as current_cost_cents
      from recipe_items ri join recipes r on r.id = ri.recipe_id join products p on p.id = r.product_id and p.deleted_at is null
      where ri.ingredient_id = ${id} order by p.name`.execute(db()),
    sql<{ c: string | null }>`select ingredient_unit_cost(${id}) as c`.execute(db()),
  ]);
  const unitCost = unitCostRes.rows[0]?.c === null || unitCostRes.rows[0]?.c === undefined ? null : Number(unitCostRes.rows[0].c);
  const stock = Number(ing.stock_qty);
  const min = Number(ing.min_stock_qty);
  const low = stock <= min;
  const last = prices.rows[0] ?? null;
  const usages = usagesRes.rows;

  return (
    <>
      <PageHeader
        title={ing.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/ingredientes" className="hover:underline">
              ← Ingredientes
            </Link>
            {ing.brand && <span>· {ing.brand}</span>}
            <Badge tone={ing.is_available ? "green" : "gray"}>{ing.is_available ? "Disponible" : "No disponible"}</Badge>
            {low && <Badge tone={stock <= 0 ? "red" : "amber"}>{stock <= 0 ? "Agotado" : "Stock bajo"}</Badge>}
          </span>
        }
      />
      {sp.creado && (
        <div className="mb-4">
          <Alert tone="green">Ingrediente creado. Registra su precio de compra para costear recetas.</Alert>
        </div>
      )}
      {sp.error === "en-uso" && (
        <div className="mb-4">
          <Alert tone="amber">No se puede eliminar: se usa en recetas. Quítalo de las recetas primero.</Alert>
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label={`Costo por ${base === "pz" ? "pieza" : base}`}
          value={unitCost === null ? "—" : formatUnitCost(unitCost)}
          hint={last ? `desde ${fmtDate(last.valid_from)}` : "sin precio registrado"}
          tone={unitCost === null ? "amber" : undefined}
        />
        <Stat
          label="Último precio"
          value={last ? <Money cents={last.price_cents} /> : "—"}
          hint={last ? (last.package_label ?? formatQty(Number(last.package_qty), base)) : undefined}
        />
        <Stat label="Stock" value={formatQty(stock, base)} hint={`mínimo ${formatQty(min, base)}`} tone={low ? "red" : undefined} />
        <Stat label="Recetas" value={usages.length} hint={usages.length ? "productos que lo usan" : "no se usa aún"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-4">
          {canWrite && (
            <Card title="Registrar nuevo precio" className="border-teal/30">
              <IngredientPriceForm
                action={recordIngredientPrice.bind(null, ing.id)}
                baseUnit={base}
                currentUnitCost={unitCost}
                suppliers={suppliers}
                defaultSupplierId={ing.supplier_id}
                usages={usages}
                lastPackage={last ? { qty: Number(last.package_qty), label: last.package_label } : null}
              />
            </Card>
          )}
          <Card title="Historial de precios">
            {prices.rows.length === 0 ? (
              <p className="text-sm text-muted">Sin precios. Sin precio, las recetas que lo usan no pueden costearse.</p>
            ) : (
              <Table className="!shadow-none">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Presentación</th>
                    <th className="text-right">Precio</th>
                    <th className="text-right">Costo unitario</th>
                    <th className="text-right">Variación</th>
                    <th>Origen</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.rows.map((p, i) => {
                    const prev = prices.rows[i + 1];
                    const change = prev
                      ? priceChangePct(Math.round(Number(prev.unit_cost) * 1_000_000), Math.round(Number(p.unit_cost) * 1_000_000))
                      : null;
                    return (
                      <tr key={p.id} className={i === 0 ? "font-medium" : ""}>
                        <td className="whitespace-nowrap">
                          {fmtDate(p.valid_from, "datetime")}
                          {i === 0 && (
                            <Badge tone="green" className="ml-2">
                              vigente
                            </Badge>
                          )}
                        </td>
                        <td>
                          {p.package_label ?? "—"}
                          <div className="text-xs text-muted">{formatQty(Number(p.package_qty), base)}</div>
                        </td>
                        <td className="text-right">
                          <Money cents={p.price_cents} />
                        </td>
                        <td className="text-right tabular-nums">
                          {formatUnitCost(Number(p.unit_cost))}
                          <span className="text-xs text-muted">/{base}</span>
                        </td>
                        <td className={`text-right tabular-nums ${change === null ? "text-muted" : change > 0 ? "text-red-d" : change < 0 ? "text-green-d" : ""}`}>
                          {change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
                        </td>
                        <td className="text-xs text-muted">
                          {p.source}
                          {p.supplier_name ? ` · ${p.supplier_name}` : ""}
                          {p.created_by_name ? ` · ${p.created_by_name}` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Movimientos de insumo">
            {canWrite && (
              <ActionForm action={recordIngredientMovement.bind(null, ing.id)} resetOnSuccess className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-[160px_1fr_140px_1fr_auto] md:items-end">
                <Select label="Tipo" name="type" id="mv-type" defaultValue="PURCHASE">
                  <option value="PURCHASE">Compra (+)</option>
                  <option value="WASTE">Merma (−)</option>
                  <option value="CORRECTION">Corrección (±)</option>
                </Select>
                <TextInput label="Cantidad" name="qty" id="mv-qty" type="number" step="any" required hint="En corrección usa signo (−) para restar." />
                <Select label="Unidad" name="unit" id="mv-unit" defaultValue={base}>
                  {PURCHASE_UNITS[base].map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </Select>
                <TextInput label="Nota" name="note" id="mv-note" maxLength={300} className="col-span-2 md:col-span-1" />
                <SubmitButton variant="secondary" pendingText="Guardando…">
                  Registrar
                </SubmitButton>
              </ActionForm>
            )}
            {movements.rows.length === 0 ? (
              <p className="text-sm text-muted">Sin movimientos.</p>
            ) : (
              <Table className="!shadow-none">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th className="text-right">Cantidad</th>
                    <th>Nota</th>
                    <th>Por</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.rows.map((m) => {
                    const n = Number(m.qty);
                    return (
                      <tr key={m.id}>
                        <td className="whitespace-nowrap">{fmtDate(m.occurred_at, "datetime")}</td>
                        <td>
                          <Badge tone={n > 0 ? "green" : m.type === "WASTE" ? "red" : "amber"}>{MOVEMENT_LABEL[m.type] ?? m.type}</Badge>
                        </td>
                        <td className={`text-right tabular-nums ${n < 0 ? "text-red-d" : ""}`}>
                          {n > 0 ? "+" : ""}
                          {fmtQty(n)} {base}
                        </td>
                        <td className="text-muted">{m.note ?? "—"}</td>
                        <td className="text-xs text-muted">{m.staff_name ?? "sistema"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Datos del ingrediente">
            {canWrite ? (
              <ActionForm action={updateIngredient.bind(null, ing.id)} className="flex flex-col gap-3">
                <TextInput label="Nombre" name="name" required maxLength={80} defaultValue={ing.name} />
                <TextInput label="Marca" name="brand" maxLength={60} defaultValue={ing.brand ?? ""} />
                <FormGrid>
                  <Select label="Unidad base" name="base_unit" defaultValue={ing.base_unit} hint={prices.rows.length ? "Bloqueada: ya tiene precios." : undefined}>
                    <option value="g">g</option>
                    <option value="ml">ml</option>
                    <option value="pz">pz</option>
                  </Select>
                  <TextInput label={`Stock mínimo (${base})`} name="min_stock_qty" type="number" step="any" min={0} defaultValue={min} />
                </FormGrid>
                <Select label="Proveedor habitual" name="supplier_id" id="ing-supplier_id" defaultValue={ing.supplier_id ?? ""}>
                  <option value="">Sin proveedor</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <TextArea label="Notas" name="notes" rows={2} maxLength={500} defaultValue={ing.notes ?? ""} />
                <Checkbox label="Disponible" name="is_available" defaultChecked={ing.is_available} />
                <div>
                  <SubmitButton>Guardar</SubmitButton>
                </div>
              </ActionForm>
            ) : (
              <dl className="text-sm">
                <dt className="text-muted">Proveedor</dt>
                <dd>{suppliers.find((s) => s.id === ing.supplier_id)?.name ?? "—"}</dd>
                <dt className="mt-2 text-muted">Notas</dt>
                <dd>{ing.notes ?? "—"}</dd>
              </dl>
            )}
          </Card>
          <Card title="Se usa en">
            {usages.length === 0 ? (
              <p className="text-sm text-muted">Ninguna receta usa este ingrediente.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {usages.map((u) => (
                  <li key={u.product_id} className="flex items-center justify-between gap-2 py-2">
                    <Link href={`/recetas/${u.product_id}`} className="hover:underline">
                      {u.product_name}
                    </Link>
                    <span className="tabular-nums text-muted">
                      {formatQty(u.qty_this, base)} · costo <Money cents={u.current_cost_cents} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canWrite && (
            <Card title="Zona de riesgo">
              <form action={deleteIngredient.bind(null, ing.id)} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted">{usages.length ? "En uso en recetas: no se puede eliminar." : "Quita el ingrediente del catálogo (se conserva el historial)."}</span>
                <ConfirmButton variant="danger" confirm={`¿Eliminar "${ing.name}"?`}>
                  Eliminar
                </ConfirmButton>
              </form>
              <div className="mt-3">
                <LinkButton href="/recetas" variant="secondary" size="sm">
                  Ir a recetas
                </LinkButton>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
