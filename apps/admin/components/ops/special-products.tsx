"use client";
/**
 * Productos especiales o temporales en Producción: alta rápida y lista con edición en línea.
 * No implementa reglas propias: cada celda llama a la misma server action que usa el catálogo
 * (precio → set_regular_price, activo → products.is_active, stock → record_stock_correction).
 */
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { idle, type ActionState } from "@/lib/action-state";
import { FormGrid, MoneyInput, TextInput } from "@/components/catalog/fields";
import { SubmitButton } from "@/components/catalog/action-form";
import { InlineCell, InlineToggle } from "@/components/catalog/inline-cell";
import { Table } from "@/components/ui";
import { fmtCents } from "@/components/catalog/formula-lines";

export type SpecialRow = {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  track_stock: boolean;
  pos_price_cents: number | null;
  web_price_cents: number | null;
  on_hand: number;
  season_start: string | null;
  season_end: string | null;
};

type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;
type IdAction = (id: string) => Promise<ActionState>;
type ValueAction = (id: string, value: unknown) => Promise<ActionState>;
type PriceAction = (
  id: string,
  channel: "all" | "pos" | "web",
  cents: unknown,
) => Promise<ActionState>;
type FlagAction = (id: string, flag: "is_active", value: boolean) => Promise<ActionState>;

const int = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 3 });

function duplicateOf(state: ActionState) {
  const d = state.data;
  if (!d || typeof d.duplicate_id !== "string") return null;
  return {
    id: d.duplicate_id,
    name: String(d.duplicate_name ?? ""),
    active: d.duplicate_active === true,
    temporary: d.duplicate_temporary === true,
    kind: d.duplicate_kind === "exact" ? ("exact" as const) : ("similar" as const),
  };
}

/** Alta: nombre, precio y stock inicial. Antes de crear, el servidor busca un producto equivalente. */
export function SpecialProductForm({
  action,
  reactivate,
  canStock,
}: {
  action: FormAction;
  reactivate: IdAction;
  canStock: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, idle);
  // El resultado de "Reactivar" se guarda junto al intento que lo originó: cuando el formulario
  // vuelve a enviarse (estado nuevo) deja de mostrarse solo, sin limpiarlo desde un efecto.
  const [reactivated, setReactivated] = useState<{ from: ActionState; result: ActionState } | null>(
    null,
  );
  const reactivateState = reactivated?.from === state ? reactivated.result : null;
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const handled = useRef<ActionState | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (state.ok && handled.current !== state) {
      handled.current = state;
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);

  const dup = duplicateOf(state);
  // React limpia el formulario al terminar la acción; con lo capturado que devuelve el servidor
  // como valor por defecto, un error no borra lo que la persona escribió.
  const typed = (k: string, fallback = "") =>
    typeof state.data?.[k] === "string" ? (state.data[k] as string) : fallback;

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      <FormGrid cols={3}>
        <TextInput
          label="Nombre"
          name="name"
          id="especial-nombre"
          required
          maxLength={120}
          placeholder="Rosca de Reyes"
          autoComplete="off"
          defaultValue={typed("form_name")}
        />
        <MoneyInput
          label="Precio (MXN)"
          name="price"
          id="especial-precio"
          required
          hint="Queda como precio regular en todos los canales."
          defaultValue={typed("form_price")}
        />
        <TextInput
          label="Stock inicial"
          name="initial_stock"
          id="especial-stock"
          type="number"
          inputMode="numeric"
          min={0}
          max={100000}
          step={1}
          defaultValue={typed("form_stock", "0")}
          disabled={!canStock}
          hint={
            canStock
              ? "Entra como corrección de inventario (motivo: alta)."
              : "Necesitas permiso de inventario para capturarlo."
          }
        />
      </FormGrid>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingText="Creando…">Crear producto especial</SubmitButton>
        {dup?.kind === "similar" && (
          <button
            type="submit"
            name="confirm_similar"
            value="1"
            className="btn btn-secondary"
            data-testid="especial-crear-igual"
          >
            Es otro producto: crear de todos modos
          </button>
        )}
        <span className="text-xs text-muted">
          Se crea activo, visible en tienda y POS, con control de stock. Lo demás (foto,
          descripción, categoría, temporada) se edita en la ficha del producto.
        </span>
      </div>
      {state.error && (
        <div
          role="alert"
          className="st-red flex flex-wrap items-center gap-3 rounded-[var(--r-btn)] px-3 py-2 text-sm"
          data-testid="especial-error"
        >
          <span>{state.error}</span>
          {dup && !dup.active && (
            <button
              type="button"
              className="btn btn-confirm btn-sm"
              disabled={pending}
              aria-busy={pending}
              data-testid="especial-reactivar"
              onClick={() =>
                startTransition(async () => {
                  const r = await reactivate(dup.id);
                  setReactivated({ from: state, result: r });
                  if (!r.error) {
                    formRef.current?.reset();
                    router.refresh();
                  }
                })
              }
            >
              {pending ? "Reactivando…" : `Reactivar "${dup.name}"`}
            </button>
          )}
          {dup && (
            <Link href={`/productos/${dup.id}`} className="btn btn-secondary btn-sm">
              Ver ficha
            </Link>
          )}
        </div>
      )}
      {reactivateState?.ok && (
        <p role="status" className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {reactivateState.ok}
        </p>
      )}
      {reactivateState?.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {reactivateState.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.ok}
        </p>
      )}
    </form>
  );
}

/** Lista de especiales con edición en línea de nombre, precio, stock y activo/inactivo. */
export function SpecialProductList({
  rows,
  canWrite,
  canStock,
  setName,
  setPrice,
  setFlag,
  setStock,
}: {
  rows: SpecialRow[];
  canWrite: boolean;
  canStock: boolean;
  setName: ValueAction;
  setPrice: PriceAction;
  setFlag: FlagAction;
  setStock: ValueAction;
}) {
  const router = useRouter();
  const after = async (r: ActionState) => {
    if (!r.error) router.refresh();
    return r;
  };
  return (
    <Table>
      <thead>
        <tr>
          <th>Producto</th>
          <th className="text-right">Precio</th>
          <th className="text-right">Stock</th>
          <th>Estado</th>
          <th>Temporada</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr
            key={p.id}
            data-testid={`especial-row-${p.id}`}
            data-product-name={p.name}
            className={p.is_active ? "" : "bg-black/[0.015]"}
          >
            <td className="min-w-48">
              <InlineCell
                kind="text"
                align="left"
                value={p.name}
                display={<span className="font-medium">{p.name}</span>}
                label={`Nombre de ${p.name}`}
                hint="cambia el nombre visible; la dirección web no cambia"
                disabled={!canWrite}
                onSave={(v) => setName(p.id, v).then(after)}
                testId={`especial-nombre-${p.id}`}
              />
              <div className="truncate text-xs text-muted">/{p.slug}</div>
            </td>
            <td className="min-w-28">
              <InlineCell
                kind="money"
                value={p.pos_price_cents}
                min={0}
                display={fmtCents(p.pos_price_cents)}
                label={`Precio de ${p.name}`}
                hint="crea un precio regular nuevo (todos los canales)"
                disabled={!canWrite}
                onSave={(v) => setPrice(p.id, "all", v).then(after)}
                testId={`especial-precio-${p.id}`}
              />
              {p.web_price_cents !== p.pos_price_cents && (
                <div className="text-right text-xs text-muted">
                  web {fmtCents(p.web_price_cents)}
                </div>
              )}
            </td>
            <td className="min-w-24">
              {p.track_stock ? (
                <InlineCell
                  kind="integer"
                  value={p.on_hand}
                  min={0}
                  display={
                    <span data-testid={`especial-stock-valor-${p.id}`}>{int(p.on_hand)}</span>
                  }
                  label={`Stock de ${p.name}`}
                  hint="queda como corrección de inventario"
                  disabled={!canStock}
                  onSave={(v) => setStock(p.id, v).then(after)}
                  testId={`especial-stock-${p.id}`}
                />
              ) : (
                <span className="text-muted">n/a</span>
              )}
            </td>
            <td>
              <InlineToggle
                checked={p.is_active}
                label={`Activo · ${p.name}`}
                onLabel="Activo"
                offLabel="Inactivo"
                disabled={!canWrite}
                testId={`especial-activo-${p.id}`}
                onToggle={(v) => setFlag(p.id, "is_active", v).then(after)}
              />
            </td>
            <td className="whitespace-nowrap text-xs text-muted">
              {p.season_start || p.season_end
                ? `${p.season_start ?? "…"} → ${p.season_end ?? "…"}`
                : "todo el año"}
            </td>
            <td className="text-right">
              <div className="flex flex-wrap justify-end gap-1">
                <Link href={`/productos/${p.id}`} className="btn btn-secondary btn-sm">
                  Ficha
                </Link>
                <Link href={`/precios/${p.id}`} className="btn btn-secondary btn-sm">
                  Precios
                </Link>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
