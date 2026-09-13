"use client";
import { useMemo, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, SubmitButton } from "./action-form";
import { FormGrid, Select, TextInput } from "./fields";
import { previewBreakdown, type Breakdown, type BreakdownSettings } from "./costing-types";
import { fmtCents, fmtPct, formulaLines } from "./formula-lines";
import { FormulaList } from "./formula";

/**
 * Parámetros globales de costeo con simulador: elige un producto y compara el costo/sugerido
 * guardados (SQL) con los que resultarían de los parámetros que estás escribiendo, antes de guardar.
 */
export function CostingSettingsForm({
  action,
  current,
  products,
  updatedAt,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  current: BreakdownSettings;
  products: Array<{ id: string; name: string; breakdown: Breakdown }>;
  updatedAt: string;
}) {
  const [targetPct, setTargetPct] = useState(String(current.default_target_margin_bps / 100));
  const [rounding, setRounding] = useState(String(current.price_rounding_cents));
  const [wastePct, setWastePct] = useState(String(current.default_waste_bps / 100));
  const [laborMode, setLaborMode] = useState(current.labor_mode);
  const [laborRate, setLaborRate] = useState((current.labor_rate_cents_per_hour / 100).toFixed(2));
  const [overheadMode, setOverheadMode] = useState(current.overhead_mode);
  const [overheadPct, setOverheadPct] = useState(String(current.overhead_pct_bps / 100));
  const [simId, setSimId] = useState(products[0]?.id ?? "");

  const draft: BreakdownSettings = useMemo(
    () => ({
      default_target_margin_bps: Math.round((Number(targetPct) || 0) * 100),
      price_rounding_cents: Number(rounding) || 100,
      default_waste_bps: Math.round((Number(wastePct) || 0) * 100),
      labor_mode: laborMode,
      labor_rate_cents_per_hour: Math.round((Number(laborRate) || 0) * 100),
      overhead_mode: overheadMode,
      overhead_pct_bps: Math.round((Number(overheadPct) || 0) * 100),
    }),
    [targetPct, rounding, wastePct, laborMode, laborRate, overheadMode, overheadPct],
  );
  const sim = products.find((p) => p.id === simId) ?? null;
  const simulated = useMemo(
    () => (sim ? previewBreakdown(sim.breakdown, { settings: draft }) : null),
    [sim, draft],
  );

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
      <ActionForm action={action} className="card flex flex-col gap-4 p-4 md:p-5">
        <div>
          <h2 className="text-base font-semibold">Parámetros de las fórmulas</h2>
          <p className="text-sm text-muted">
            Aplican a todos los productos salvo que la receta tenga su propio valor (merma y margen
            objetivo). Última edición: {updatedAt}.
          </p>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
            Precio sugerido
          </legend>
          <FormGrid>
            <TextInput
              label="Margen objetivo por defecto (%)"
              name="default_target_margin_pct"
              id="cs-target"
              type="number"
              step="any"
              min={0}
              max={99}
              required
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              hint="Precio sugerido = costo ÷ (1 − margen)"
            />
            <Select
              label="Redondear el precio sugerido a múltiplos de"
              name="price_rounding_cents"
              id="cs-rounding"
              value={rounding}
              onChange={(e) => setRounding(e.target.value)}
              hint="Siempre hacia arriba"
            >
              <option value="50">$0.50</option>
              <option value="100">$1.00</option>
              <option value="500">$5.00</option>
              <option value="1000">$10.00</option>
            </Select>
          </FormGrid>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
            Costo por pieza
          </legend>
          <FormGrid>
            <TextInput
              label="Merma / desperdicio por defecto (%)"
              name="default_waste_pct"
              id="cs-waste"
              type="number"
              step="any"
              min={0}
              max={100}
              required
              value={wastePct}
              onChange={(e) => setWastePct(e.target.value)}
              hint="Costo por pieza = (insumos + MO + indirectos) ÷ rendimiento × (1 + merma)"
            />
          </FormGrid>
          <FormGrid>
            <Select
              label="Mano de obra"
              name="labor_mode"
              id="cs-labor-mode"
              value={laborMode}
              onChange={(e) => setLaborMode(e.target.value as BreakdownSettings["labor_mode"])}
            >
              <option value="per_batch">Monto fijo por lote (cada receta)</option>
              <option value="per_hour">Minutos por lote × tarifa por hora</option>
            </Select>
            <TextInput
              label="Tarifa de mano de obra ($ por hora)"
              name="labor_rate_per_hour"
              id="cs-labor-rate"
              type="number"
              step="0.01"
              min={0}
              value={laborRate}
              onChange={(e) => setLaborRate(e.target.value)}
              disabled={laborMode !== "per_hour"}
              hint={
                laborMode === "per_hour"
                  ? "MO = minutos ÷ 60 × tarifa. Recetas sin minutos usan su monto por lote."
                  : "Solo aplica con MO por hora."
              }
            />
          </FormGrid>
          <FormGrid>
            <Select
              label="Gastos indirectos"
              name="overhead_mode"
              id="cs-overhead-mode"
              value={overheadMode}
              onChange={(e) =>
                setOverheadMode(e.target.value as BreakdownSettings["overhead_mode"])
              }
            >
              <option value="fixed">Monto fijo por lote (cada receta)</option>
              <option value="pct_of_ingredients">Porcentaje de los insumos</option>
            </Select>
            <TextInput
              label="Indirectos (% de los insumos)"
              name="overhead_pct"
              id="cs-overhead-pct"
              type="number"
              step="any"
              min={0}
              max={1000}
              value={overheadPct}
              onChange={(e) => setOverheadPct(e.target.value)}
              disabled={overheadMode !== "pct_of_ingredients"}
              hint={
                overheadMode === "pct_of_ingredients"
                  ? "Indirectos = insumos × %"
                  : "Solo aplica con indirectos como % de insumos."
              }
            />
          </FormGrid>
        </fieldset>
        {laborMode !== "per_hour" && (
          <input type="hidden" name="labor_rate_per_hour" value={laborRate} readOnly />
        )}
        {overheadMode !== "pct_of_ingredients" && (
          <input type="hidden" name="overhead_pct" value={overheadPct} readOnly />
        )}
        <div>
          <SubmitButton>Guardar parámetros</SubmitButton>
        </div>
      </ActionForm>

      <section className="card p-4 md:p-5" aria-labelledby="sim-title">
        <h2 id="sim-title" className="text-base font-semibold">
          Simulador (antes de guardar)
        </h2>
        <p className="mb-3 text-sm text-muted">
          Elige un producto y compara lo guardado con lo que resultaría con los parámetros de la
          izquierda. Nada se guarda hasta que pulses “Guardar parámetros”.
        </p>
        <label htmlFor="sim-product" className="label">
          Producto
        </label>
        <select
          id="sim-product"
          className="input"
          value={simId}
          onChange={(e) => setSimId(e.target.value)}
        >
          {products.length === 0 && <option value="">Sin productos con receta</option>}
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {sim && simulated && (
          <div className="mt-3 grid gap-3" aria-live="polite">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div />
              <div className="text-right text-xs font-semibold uppercase tracking-wide text-muted">
                Guardado
              </div>
              <div className="text-right text-xs font-semibold uppercase tracking-wide text-teal-d">
                Simulado
              </div>
              <Row
                label="Costo por pieza"
                a={fmtCents(sim.breakdown.cost_per_piece_cents)}
                b={fmtCents(simulated.cost_per_piece_cents)}
                changed={sim.breakdown.cost_per_piece_cents !== simulated.cost_per_piece_cents}
                testId="sim-cost"
              />
              <Row
                label="Margen POS"
                a={fmtPct(sim.breakdown.pos_margin_bps)}
                b={fmtPct(simulated.pos_margin_bps)}
                changed={sim.breakdown.pos_margin_bps !== simulated.pos_margin_bps}
              />
              <Row
                label="Margen objetivo"
                a={fmtPct(sim.breakdown.target_margin_bps, 0)}
                b={fmtPct(simulated.target_margin_bps, 0)}
                changed={sim.breakdown.target_margin_bps !== simulated.target_margin_bps}
              />
              <Row
                label="Precio sugerido"
                a={fmtCents(sim.breakdown.suggested_price_cents)}
                b={fmtCents(simulated.suggested_price_cents)}
                changed={sim.breakdown.suggested_price_cents !== simulated.suggested_price_cents}
                testId="sim-suggested"
              />
            </div>
            <div className="rounded-[var(--r-card)] bg-black/[0.03] px-3 py-2">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-teal-d">
                Fórmulas simuladas
              </div>
              <FormulaList compact lines={formulaLines(simulated, { channel: "pos" })} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  a,
  b,
  changed,
  testId,
}: {
  label: string;
  a: string;
  b: string;
  changed: boolean;
  testId?: string;
}) {
  return (
    <>
      <div>{label}</div>
      <div className="text-right tabular-nums">{a}</div>
      <div
        className={`text-right font-semibold tabular-nums ${changed ? "text-teal-d" : ""}`}
        data-testid={testId}
      >
        {b}
        {changed && <span className="sr-only"> (cambia)</span>}
      </div>
    </>
  );
}
