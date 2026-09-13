"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { costRecipe, formatQty, toBaseQty, toCents, type BaseUnit } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { settingsFromRow, type BreakdownSettings } from "./costing-types";
import { fmtCents } from "./formula-lines";
import { Formula } from "./formula";
import { InlineCell } from "./inline-cell";
import { PURCHASE_UNITS, formatUnitCost } from "./units";

/** Receta que usa el insumo, con lo necesario para recalcular su costo en el cliente (espejo de product_cost_impact). */
export type IngredientUsage = {
  product_id: string;
  product_name: string;
  yield_qty: number;
  labor_cents: number;
  overhead_cents: number;
  labor_minutes: number | null;
  waste_bps: number | null;
  other_cost: number; // MXN: suma de las demás líneas (qty × costo unitario vigente)
  qty_this: number; // cantidad de este ingrediente en la receta (unidad base)
  current_cost_cents: number | null;
};

export function unitCostFor(
  priceCents: number,
  qty: number,
  unit: string,
  base: BaseUnit,
): number | null {
  try {
    const b = toBaseQty(qty, unit, base).qty;
    if (b <= 0) return null;
    return priceCents / 100 / b;
  } catch {
    return null;
  }
}

/** Impacto en vivo de un costo unitario nuevo sobre las recetas que usan el insumo (misma fórmula que SQL). */
export function impactOf(usages: IngredientUsage[], unitCost: number, settings: BreakdownSettings) {
  const s = settingsFromRow(settings);
  return usages
    .map((u) => {
      const c = costRecipe({
        yieldQty: u.yield_qty,
        laborCents: u.labor_cents,
        overheadCents: u.overhead_cents,
        laborMinutes: u.labor_minutes,
        wasteBps: u.waste_bps,
        settings: s,
        lines: [
          { ingredientId: "otros", qty: u.other_cost, unitCost: 1 },
          { ingredientId: "este", qty: u.qty_this, unitCost },
        ],
      });
      return {
        ...u,
        new_cost_cents: c.costPerPieceCents,
        delta: u.current_cost_cents === null ? null : c.costPerPieceCents - u.current_cost_cents,
        formula: `(${fmtCents(u.other_cost * 100)} + ${formatQty(u.qty_this, "g").replace(/ g$/, "")} × ${formatUnitCost(unitCost)} + ${fmtCents(c.laborExact)} + ${fmtCents(c.overheadExact)}) ÷ ${u.yield_qty} × (1 + ${(c.wasteBps / 100).toFixed(2)}%)`,
      };
    })
    .filter((u) => u.delta === null || u.delta !== 0);
}

/**
 * Celda "Último precio" de la lista de ingredientes: al editar muestra precio + contenido + unidad,
 * el costo unitario resultante y cuántos productos cambian de costo; Enter registra un precio histórico nuevo.
 */
export function IngredientPriceCell({
  ingredientId,
  name,
  baseUnit,
  currentUnitCost,
  last,
  usages,
  settings,
  canWrite,
  action,
}: {
  ingredientId: string;
  name: string;
  baseUnit: BaseUnit;
  currentUnitCost: number | null;
  last: { price_cents: number; package_qty: number; label: string | null } | null;
  usages: IngredientUsage[];
  settings: BreakdownSettings;
  canWrite: boolean;
  action: (id: string, input: unknown) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<string>(baseUnit);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const units = PURCHASE_UNITS[baseUnit];

  const preview = useMemo(() => {
    // Los teclados es-MX escriben coma decimal: "45,50" debe valer lo mismo que "45.50".
    const p = Number(price.replace(",", "."));
    const q = Number(qty.replace(",", "."));
    if (!price || !qty || !Number.isFinite(p) || !Number.isFinite(q) || p < 0 || q <= 0)
      return null;
    const uc = unitCostFor(toCents(p), q, unit, baseUnit);
    if (uc === null) return null;
    return {
      unitCost: uc,
      baseQty: toBaseQty(q, unit, baseUnit).qty,
      impact: impactOf(usages, uc, settings),
    };
  }, [price, qty, unit, baseUnit, usages, settings]);

  function start() {
    if (!canWrite) return;
    setPrice(last ? (last.price_cents / 100).toFixed(2) : "");
    setQty(last ? String(last.package_qty) : "");
    setUnit(baseUnit);
    setError(null);
    setOk(null);
    setOpen(true);
  }
  function submit() {
    if (!preview) {
      setError("Captura precio y contenido");
      return;
    }
    startTransition(async () => {
      const r = await action(ingredientId, {
        price_cents: toCents(Number(price.replace(",", "."))),
        qty: Number(qty.replace(",", ".")),
        unit,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      setOk(r.ok ?? "Precio registrado.");
      setOpen(false);
      router.refresh();
    });
  }
  const per = baseUnit === "pz" ? "pieza" : baseUnit;

  if (!open)
    return (
      <span data-inline-cell data-disabled={canWrite ? undefined : "true"} className="block">
        <button
          type="button"
          className="inline-cell text-left"
          onClick={start}
          disabled={!canWrite}
          aria-label={`Último precio de ${name}. Registrar nuevo precio`}
          title={canWrite ? "Clic para registrar un precio nuevo" : undefined}
        >
          <span>
            {last ? (
              <>
                <span className="font-medium">{fmtCents(last.price_cents)}</span>
                <span className="text-muted">
                  {" "}
                  · {last.label ?? formatQty(last.package_qty, baseUnit)}
                </span>
              </>
            ) : (
              <span className="text-muted">— {canWrite ? "(registrar)" : ""}</span>
            )}
            {ok && <span className="block text-xs text-green-d">{ok}</span>}
          </span>
        </button>
      </span>
    );

  const inputKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="min-w-72" role="group" aria-label={`Nuevo precio de ${name}`}>
      <div className="flex flex-wrap items-end gap-1.5">
        <div>
          <label htmlFor={`ip-price-${ingredientId}`} className="label !mb-0.5 !text-[11px]">
            Precio (MXN)
          </label>
          <input
            id={`ip-price-${ingredientId}`}
            className="input min-h-11 !w-24 !py-1"
            inputMode="decimal"
            autoFocus
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            onKeyDown={inputKeys}
            disabled={pending}
          />
        </div>
        <div>
          <label htmlFor={`ip-qty-${ingredientId}`} className="label !mb-0.5 !text-[11px]">
            Contenido
          </label>
          <input
            id={`ip-qty-${ingredientId}`}
            className="input min-h-11 !w-20 !py-1"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={inputKeys}
            disabled={pending}
          />
        </div>
        <div>
          <label htmlFor={`ip-unit-${ingredientId}`} className="label !mb-0.5 !text-[11px]">
            Unidad
          </label>
          <select
            id={`ip-unit-${ingredientId}`}
            className="input min-h-11 !w-28 !py-1"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onKeyDown={inputKeys}
            disabled={pending}
          >
            {units.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm !min-h-11"
          onClick={submit}
          disabled={pending || !preview}
          aria-busy={pending}
        >
          {pending ? "Registrando…" : "Registrar"}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm !min-h-11"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancelar
        </button>
      </div>
      <div className="mt-1 text-xs" aria-live="polite">
        {preview ? (
          <>
            <Formula
              compact
              line={{
                key: "uc",
                label: `Costo por ${per}`,
                expr: `${fmtCents(toCents(Number(price.replace(",", "."))))} ÷ ${formatQty(preview.baseQty, baseUnit)}`,
                result: `${formatUnitCost(preview.unitCost)}/${baseUnit}`,
                note:
                  currentUnitCost !== null
                    ? `antes ${formatUnitCost(currentUnitCost)}/${baseUnit}`
                    : "sin precio anterior",
              }}
            />
            <p className={preview.impact.length ? "text-amber-d" : "text-muted"}>
              {usages.length === 0
                ? "Ninguna receta usa este insumo."
                : preview.impact.length === 0
                  ? "Ningún producto cambia de costo."
                  : `Cambia el costo de ${preview.impact.length} producto${preview.impact.length === 1 ? "" : "s"}: ` +
                    preview.impact
                      .slice(0, 4)
                      .map(
                        (u) =>
                          `${u.product_name} ${fmtCents(u.current_cost_cents)} → ${fmtCents(u.new_cost_cents)}`,
                      )
                      .join(" · ") +
                    (preview.impact.length > 4 ? " …" : "")}
            </p>
          </>
        ) : (
          <span className="text-muted">Costo unitario = precio ÷ contenido (en {baseUnit}).</span>
        )}
        {error && (
          <p role="alert" className="text-red-d">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function IngredientMinStockCell({
  ingredientId,
  name,
  baseUnit,
  value,
  canWrite,
  action,
}: {
  ingredientId: string;
  name: string;
  baseUnit: BaseUnit;
  value: number;
  canWrite: boolean;
  action: (id: string, qty: unknown) => Promise<ActionState>;
}) {
  const router = useRouter();
  return (
    <InlineCell
      kind="number"
      value={value}
      min={0}
      step="any"
      label={`Stock mínimo de ${name} (${baseUnit})`}
      display={<span className="text-muted">{formatQty(value, baseUnit)}</span>}
      hint={`en ${baseUnit}`}
      disabled={!canWrite}
      onSave={async (v) => {
        const r = await action(ingredientId, v);
        if (!r.error) router.refresh();
        return r;
      }}
    />
  );
}
