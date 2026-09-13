"use client";
import { useMemo, useState } from "react";
import {
  formatMXN,
  formatQty,
  priceChangePct,
  toBaseQty,
  toCents,
  type BaseUnit,
} from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { PURCHASE_UNITS, formatUnitCost } from "./units";
import { ActionForm, SubmitButton } from "./action-form";
import { Checkbox, FormGrid, MoneyInput, Select, TextInput } from "./fields";
import { impactOf, unitCostFor, type IngredientUsage } from "./ingredient-inline";
import type { BreakdownSettings } from "./costing-types";
import { Formula } from "./formula";
import { fmtCents } from "./formula-lines";

export type { IngredientUsage } from "./ingredient-inline";
export { unitCostFor } from "./ingredient-inline";

export function IngredientPriceForm({
  action,
  baseUnit,
  currentUnitCost,
  suppliers,
  defaultSupplierId,
  usages,
  lastPackage,
  settings,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  baseUnit: BaseUnit;
  currentUnitCost: number | null;
  suppliers: Array<{ id: string; name: string }>;
  defaultSupplierId: string | null;
  usages: IngredientUsage[];
  lastPackage?: { qty: number; label: string | null } | null;
  settings: BreakdownSettings;
}) {
  const units = PURCHASE_UNITS[baseUnit];
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(lastPackage ? String(lastPackage.qty) : "");
  const [unit, setUnit] = useState(units[0]!.value);
  const [addStock, setAddStock] = useState(false);

  const preview = useMemo(() => {
    const p = Number(price);
    const q = Number(qty);
    if (!price || !qty || !Number.isFinite(p) || !Number.isFinite(q) || p < 0 || q <= 0)
      return null;
    const unitCost = unitCostFor(toCents(p), q, unit, baseUnit);
    if (unitCost === null) return null;
    const baseQty = toBaseQty(q, unit, baseUnit).qty;
    const change =
      currentUnitCost && currentUnitCost > 0
        ? priceChangePct(Math.round(currentUnitCost * 1_000_000), Math.round(unitCost * 1_000_000))
        : null;
    const impact = impactOf(usages, unitCost, settings);
    return { unitCost, baseQty, change, impact };
  }, [price, qty, unit, baseUnit, currentUnitCost, usages, settings]);

  const per = baseUnit === "pz" ? "pieza" : baseUnit;

  return (
    <ActionForm action={action} resetOnSuccess className="flex flex-col gap-3">
      <FormGrid cols={3}>
        <MoneyInput
          label="Precio pagado (MXN)"
          name="price"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <TextInput
          label="Contenido"
          name="qty"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
        <Select
          label="Unidad de compra"
          name="unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        >
          {units.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </Select>
      </FormGrid>
      <FormGrid>
        <TextInput
          label="Presentación (opcional)"
          name="package_label"
          maxLength={80}
          placeholder={lastPackage?.label ?? "Ej. Caja 1.808 kg"}
        />
        <Select label="Proveedor" name="supplier_id" defaultValue={defaultSupplierId ?? ""}>
          <option value="">Sin proveedor</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </FormGrid>
      <div className="flex flex-wrap items-end gap-4">
        <Checkbox
          label="También registrar la compra en inventario"
          name="add_stock"
          hint="Suma el contenido × empaques al stock del insumo."
          checked={addStock}
          onChange={(e) => setAddStock(e.target.checked)}
        />
        {addStock && (
          <TextInput
            label="Empaques comprados"
            name="packages"
            type="number"
            step="any"
            min={0.001}
            defaultValue={1}
            className="w-40"
          />
        )}
      </div>

      <div className="st-blue rounded-[var(--r-card)] px-4 py-3 text-sm" aria-live="polite">
        {preview ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Formula
                line={{
                  key: "unit-cost",
                  label: `Costo por ${per}`,
                  expr: `${fmtCents(toCents(Number(price)))} ÷ ${formatQty(preview.baseQty, baseUnit)}`,
                  result: `${formatUnitCost(preview.unitCost)}/${baseUnit}`,
                }}
              />
              {preview.change !== null && (
                <span
                  className={`font-semibold tabular-nums ${preview.change > 0 ? "text-red-d" : preview.change < 0 ? "text-green-d" : ""}`}
                >
                  {preview.change > 0 ? "▲" : preview.change < 0 ? "▼" : "="}{" "}
                  {Math.abs(preview.change).toFixed(1)}% vs. anterior
                </span>
              )}
              {preview.change === null && currentUnitCost !== null && (
                <span className="text-xs opacity-80">
                  costo anterior: {formatUnitCost(currentUnitCost)}
                </span>
              )}
            </div>
            {usages.length > 0 && (
              <div className="mt-2">
                {preview.impact.length === 0 ? (
                  <p className="text-xs opacity-80">Ningún producto cambia de costo por pieza.</p>
                ) : (
                  <>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-80">
                      Cambia el costo de {preview.impact.length} producto
                      {preview.impact.length === 1 ? "" : "s"}
                    </p>
                    <ul className="grid gap-1 md:grid-cols-2">
                      {preview.impact.map((u) => (
                        <li
                          key={u.product_id}
                          className="flex items-center justify-between gap-2 tabular-nums"
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{u.product_name}</span>
                            <span
                              className="block truncate font-mono text-[11px] opacity-70"
                              title={u.formula}
                            >
                              {u.formula}
                            </span>
                          </span>
                          <span className="shrink-0">
                            {u.current_cost_cents === null ? "—" : formatMXN(u.current_cost_cents)}{" "}
                            → <strong>{formatMXN(u.new_cost_cents)}</strong>
                            {u.delta !== null && (
                              <span
                                className={`ml-1 text-xs ${u.delta > 0 ? "text-red-d" : "text-green-d"}`}
                              >
                                ({u.delta > 0 ? "+" : ""}
                                {formatMXN(u.delta)})
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <span className="opacity-80">
            Captura precio y contenido para ver el costo por {per} y qué productos cambian.
          </span>
        )}
      </div>
      <div>
        <SubmitButton pendingText="Registrando…">Registrar precio</SubmitButton>
      </div>
    </ActionForm>
  );
}
