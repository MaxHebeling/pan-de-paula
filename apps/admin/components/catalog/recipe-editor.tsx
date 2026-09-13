"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatMXN, formatQty, toBaseQty, toCents, type BaseUnit } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, SubmitButton } from "./action-form";
import { FormGrid, MoneyInput, TextArea, TextInput } from "./fields";
import { PURCHASE_UNITS, formatUnitCost } from "./units";
import {
  emptyBreakdown,
  marginTone,
  previewBreakdown,
  type Breakdown,
  type BreakdownLine,
  type BreakdownSettings,
} from "./costing-types";
import { fmtCents, fmtPct, formulaLines } from "./formula-lines";
import { Formula, FormulaList } from "./formula";

export type RecipeIngredient = {
  id: string;
  name: string;
  base_unit: BaseUnit;
  unit_cost: number | null;
  is_available: boolean;
  last_price_cents?: number | null;
  last_package_qty?: number | null;
};
export type RecipeLineInput = { ingredient_id: string; qty: number; note: string | null };
export type RecipeInitial = {
  yield_qty: number;
  yield_label: string | null;
  labor_cents: number;
  overhead_cents: number;
  notes: string | null;
  items: RecipeLineInput[];
  waste_bps: number | null;
  target_margin_bps: number | null;
  labor_minutes: number | null;
};

type Line = { key: number; ingredient_id: string; qty: string; unit: string; note: string };
type QuickPrice = {
  price: string;
  qty: string;
  unit: string;
  error: string | null;
  pending: boolean;
};

let seq = 1;

export function RecipeEditor({
  action,
  ingredients,
  initial,
  breakdown,
  settings,
  productId,
  productName,
  posPriceCents,
  webPriceCents,
  canWrite,
  canWritePrice,
  quickPriceAction,
  applySuggestedAction,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  ingredients: RecipeIngredient[];
  initial: RecipeInitial | null;
  /** Desglose guardado (SQL, la verdad); null si no hay receta. */
  breakdown: Breakdown | null;
  settings: BreakdownSettings;
  productId: string;
  productName: string;
  posPriceCents: number | null;
  webPriceCents: number | null;
  canWrite: boolean;
  canWritePrice: boolean;
  quickPriceAction: (ingredientId: string, input: unknown) => Promise<ActionState>;
  applySuggestedAction: (productId: string) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [unitCostOverride, setUnitCostOverride] = useState<Record<string, number>>({});
  const byId = useMemo(
    () =>
      new Map(
        ingredients.map((i) => [i.id, { ...i, unit_cost: unitCostOverride[i.id] ?? i.unit_cost }]),
      ),
    [ingredients, unitCostOverride],
  );
  const [lines, setLines] = useState<Line[]>(() =>
    (initial?.items ?? []).map((it) => {
      const base = ingredients.find((i) => i.id === it.ingredient_id)?.base_unit ?? "g";
      // Se guarda en unidad base; para leer cómodo, 1000 g/ml exactos se muestran como kg/L.
      const big = base !== "pz" && it.qty >= 1000 && it.qty % 1000 === 0;
      return {
        key: seq++,
        ingredient_id: it.ingredient_id,
        qty: String(big ? it.qty / 1000 : it.qty),
        unit: big ? (base === "g" ? "kg" : "l") : base,
        note: it.note ?? "",
      };
    }),
  );
  const [yieldQty, setYieldQty] = useState(String(initial?.yield_qty ?? 1));
  const [labor, setLabor] = useState(initial ? (initial.labor_cents / 100).toFixed(2) : "0");
  const [overhead, setOverhead] = useState(
    initial ? (initial.overhead_cents / 100).toFixed(2) : "0",
  );
  const [laborMinutes, setLaborMinutes] = useState(
    initial?.labor_minutes === null || initial?.labor_minutes === undefined
      ? ""
      : String(initial.labor_minutes),
  );
  const [wastePct, setWastePct] = useState(
    initial?.waste_bps === null || initial?.waste_bps === undefined
      ? ""
      : String(initial.waste_bps / 100),
  );
  const [targetPct, setTargetPct] = useState(
    initial?.target_margin_bps === null || initial?.target_margin_bps === undefined
      ? ""
      : String(initial.target_margin_bps / 100),
  );
  const [adding, setAdding] = useState("");
  const [quick, setQuick] = useState<Record<number, QuickPrice>>({});
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applying, startApply] = useTransition();

  const perHour = settings.labor_mode === "per_hour";
  const pctOverhead = settings.overhead_mode === "pct_of_ingredients";

  const preview = useMemo(() => {
    const y = Number(yieldQty);
    if (!Number.isFinite(y) || y <= 0) return null;
    const bLines: BreakdownLine[] = lines.map((l) => {
      const ing = byId.get(l.ingredient_id);
      let baseQty = 0;
      try {
        baseQty = ing ? toBaseQty(Number(l.qty) || 0, l.unit, ing.base_unit).qty : 0;
      } catch {
        baseQty = 0;
      }
      return {
        ingredient_id: l.ingredient_id,
        name: ing?.name ?? "—",
        base_unit: ing?.base_unit ?? "g",
        qty: baseQty,
        unit_cost: ing?.unit_cost ?? null,
        cost_mxn: null,
      };
    });
    const base =
      breakdown ??
      emptyBreakdown(productId, productName, settings, { pos: posPriceCents, web: webPriceCents });
    const b = previewBreakdown(base, {
      lines: bLines,
      yield_qty: y,
      labor_cents: safeCents(labor),
      overhead_cents: safeCents(overhead),
      labor_minutes: laborMinutes.trim() === "" ? null : Number(laborMinutes) || 0,
      waste_bps: wastePct.trim() === "" ? null : Math.round((Number(wastePct) || 0) * 100),
      target_margin_bps:
        targetPct.trim() === "" ? null : Math.round((Number(targetPct) || 0) * 100),
      pos_price_cents: posPriceCents,
      web_price_cents: webPriceCents,
      settings,
    });
    const items = bLines
      .filter((l) => l.ingredient_id && l.qty > 0)
      .map((l, i) => ({
        ingredient_id: l.ingredient_id,
        qty: l.qty,
        note: lines[i]?.note || null,
      }));
    return { b, items, lineCosts: b.lines.map((l) => l.cost_mxn) };
  }, [
    lines,
    yieldQty,
    labor,
    overhead,
    laborMinutes,
    wastePct,
    targetPct,
    posPriceCents,
    webPriceCents,
    byId,
    breakdown,
    settings,
    productId,
    productName,
  ]);

  const available = ingredients.filter((i) => !lines.some((l) => l.ingredient_id === i.id));

  function addLine(id: string) {
    const ing = byId.get(id);
    if (!ing) return;
    setLines((ls) => [
      ...ls,
      { key: seq++, ingredient_id: id, qty: "", unit: ing.base_unit, note: "" },
    ]);
    setAdding("");
  }
  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function remove(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }
  function openQuick(l: Line) {
    const ing = byId.get(l.ingredient_id);
    setQuick((q) => ({
      ...q,
      [l.key]: {
        price: ing?.last_price_cents ? (ing.last_price_cents / 100).toFixed(2) : "",
        qty: ing?.last_package_qty ? String(ing.last_package_qty) : "",
        unit: ing?.base_unit ?? "g",
        error: null,
        pending: false,
      },
    }));
  }
  function closeQuick(key: number) {
    setQuick((q) => {
      const n = { ...q };
      delete n[key];
      return n;
    });
  }
  async function submitQuick(l: Line) {
    const qp = quick[l.key];
    const ing = byId.get(l.ingredient_id);
    if (!qp || !ing) return;
    const priceCents = safeCents(qp.price);
    const qty = Number(qp.qty);
    setQuick((q) => ({ ...q, [l.key]: { ...qp, pending: true, error: null } }));
    const r = await quickPriceAction(ing.id, { price_cents: priceCents, qty, unit: qp.unit });
    if (r.error) {
      setQuick((q) => ({ ...q, [l.key]: { ...qp, pending: false, error: r.error ?? null } }));
      return;
    }
    const uc = Number(r.data?.unit_cost);
    if (Number.isFinite(uc)) setUnitCostOverride((o) => ({ ...o, [ing.id]: uc }));
    closeQuick(l.key);
    router.refresh();
  }
  function applySuggested() {
    setApplyMsg(null);
    startApply(async () => {
      const r = await applySuggestedAction(productId);
      setApplyMsg(r.error ?? r.ok ?? null);
      if (!r.error) router.refresh();
    });
  }

  const b = preview?.b ?? null;
  const saved = breakdown;
  const savedTone = saved ? marginTone(saved.pos_margin_bps, saved.target_margin_bps) : "gray";

  return (
    <ActionForm action={action} className="flex flex-col gap-5">
      <input type="hidden" name="items" value={JSON.stringify(preview?.items ?? [])} readOnly />

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Ingredientes</h3>
          {canWrite && (
            <div className="flex items-center gap-2">
              <label htmlFor="add-ingredient" className="sr-only">
                Agregar ingrediente
              </label>
              <select
                id="add-ingredient"
                className="input !w-64 !py-1.5 text-sm"
                value={adding}
                onChange={(e) => addLine(e.target.value)}
              >
                <option value="">+ Agregar ingrediente…</option>
                {available.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.unit_cost === null ? " (sin precio)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {lines.length === 0 ? (
          <p className="rounded-[var(--r-card)] border border-dashed border-line p-4 text-center text-sm text-muted">
            Sin líneas. Agrega los ingredientes con la cantidad que lleva <strong>un lote</strong>{" "}
            de la receta.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted">
              <thead>
                <tr>
                  <th>Ingrediente</th>
                  <th className="w-32">Cantidad</th>
                  <th className="w-36">Unidad</th>
                  <th className="text-right">Costo unit.</th>
                  <th className="text-right">Costo línea</th>
                  <th className="w-40">Nota</th>
                  {canWrite && <th className="w-24" />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const ing = byId.get(l.ingredient_id);
                  const lineCost = preview?.lineCosts[idx] ?? null;
                  const qp = quick[l.key];
                  const qpUnitCost =
                    qp && ing && Number(qp.qty) > 0 && qp.price !== ""
                      ? unitCostFor(safeCents(qp.price), Number(qp.qty), qp.unit, ing.base_unit)
                      : null;
                  return (
                    <RowPair key={l.key}>
                      <tr className="border-t border-line">
                        <td>
                          <div className="font-medium">{ing?.name ?? "—"}</div>
                          {ing && ing.unit_cost === null && (
                            <span className="text-xs text-amber-d">
                              sin precio: no suma al costo
                            </span>
                          )}
                          {ing && !ing.is_available && (
                            <span className="text-xs text-muted"> · no disponible</span>
                          )}
                        </td>
                        <td>
                          <label htmlFor={`qty-${l.key}`} className="sr-only">
                            Cantidad de {ing?.name}
                          </label>
                          <input
                            id={`qty-${l.key}`}
                            type="number"
                            step="any"
                            min={0}
                            className="input !py-1.5"
                            value={l.qty}
                            onChange={(e) => update(l.key, { qty: e.target.value })}
                            disabled={!canWrite}
                            required
                          />
                        </td>
                        <td>
                          <label htmlFor={`unit-${l.key}`} className="sr-only">
                            Unidad de {ing?.name}
                          </label>
                          <select
                            id={`unit-${l.key}`}
                            className="input !py-1.5"
                            value={l.unit}
                            onChange={(e) => update(l.key, { unit: e.target.value })}
                            disabled={!canWrite}
                          >
                            {(ing ? PURCHASE_UNITS[ing.base_unit] : []).map((u) => (
                              <option key={u.value} value={u.value}>
                                {u.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="text-right tabular-nums text-muted">
                          {ing?.unit_cost === null || ing?.unit_cost === undefined
                            ? "—"
                            : `${formatUnitCost(ing.unit_cost)}/${ing.base_unit}`}
                        </td>
                        <td className="text-right tabular-nums">
                          {lineCost === null || lineCost === undefined
                            ? "—"
                            : `$${lineCost.toFixed(2)}`}
                        </td>
                        <td>
                          <label htmlFor={`note-${l.key}`} className="sr-only">
                            Nota
                          </label>
                          <input
                            id={`note-${l.key}`}
                            className="input !py-1.5"
                            maxLength={120}
                            value={l.note}
                            onChange={(e) => update(l.key, { note: e.target.value })}
                            disabled={!canWrite}
                            placeholder="opcional"
                          />
                        </td>
                        {canWrite && (
                          <td>
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => (qp ? closeQuick(l.key) : openQuick(l))}
                                aria-expanded={!!qp}
                                aria-label={`Registrar nuevo precio de ${ing?.name}`}
                                title="Registrar nuevo precio del insumo sin salir"
                              >
                                $
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                onClick={() => remove(l.key)}
                                aria-label={`Quitar ${ing?.name}`}
                              >
                                ✕
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                      {qp && ing && (
                        <tr className="bg-black/[0.02]">
                          <td colSpan={canWrite ? 7 : 6} className="!py-2">
                            <div
                              className="flex flex-wrap items-end gap-2"
                              role="group"
                              aria-label={`Nuevo precio de ${ing.name}`}
                            >
                              <div>
                                <label htmlFor={`qp-price-${l.key}`} className="label">
                                  Precio pagado (MXN)
                                </label>
                                <input
                                  id={`qp-price-${l.key}`}
                                  className="input !w-32 !py-1.5"
                                  inputMode="decimal"
                                  value={qp.price}
                                  onChange={(e) =>
                                    setQuick((q) => ({
                                      ...q,
                                      [l.key]: { ...qp, price: e.target.value },
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void submitQuick(l);
                                    }
                                    if (e.key === "Escape") closeQuick(l.key);
                                  }}
                                />
                              </div>
                              <div>
                                <label htmlFor={`qp-qty-${l.key}`} className="label">
                                  Contenido
                                </label>
                                <input
                                  id={`qp-qty-${l.key}`}
                                  className="input !w-28 !py-1.5"
                                  inputMode="decimal"
                                  value={qp.qty}
                                  onChange={(e) =>
                                    setQuick((q) => ({
                                      ...q,
                                      [l.key]: { ...qp, qty: e.target.value },
                                    }))
                                  }
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      void submitQuick(l);
                                    }
                                    if (e.key === "Escape") closeQuick(l.key);
                                  }}
                                />
                              </div>
                              <div>
                                <label htmlFor={`qp-unit-${l.key}`} className="label">
                                  Unidad
                                </label>
                                <select
                                  id={`qp-unit-${l.key}`}
                                  className="input !w-36 !py-1.5"
                                  value={qp.unit}
                                  onChange={(e) =>
                                    setQuick((q) => ({
                                      ...q,
                                      [l.key]: { ...qp, unit: e.target.value },
                                    }))
                                  }
                                >
                                  {PURCHASE_UNITS[ing.base_unit].map((u) => (
                                    <option key={u.value} value={u.value}>
                                      {u.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm !min-h-11"
                                disabled={qp.pending || qpUnitCost === null}
                                aria-busy={qp.pending}
                                onClick={() => void submitQuick(l)}
                              >
                                {qp.pending ? "Registrando…" : "Registrar precio"}
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm !min-h-11"
                                onClick={() => closeQuick(l.key)}
                              >
                                Cancelar
                              </button>
                              <div className="basis-full text-xs tabular-nums" aria-live="polite">
                                {qpUnitCost !== null ? (
                                  <Formula
                                    compact
                                    line={{
                                      key: "qp",
                                      label: "Costo unitario nuevo",
                                      expr: `${fmtCents(safeCents(qp.price))} ÷ ${formatQty(toBaseQty(Number(qp.qty), qp.unit, ing.base_unit).qty, ing.base_unit)}`,
                                      result: `${formatUnitCost(qpUnitCost)}/${ing.base_unit}`,
                                      note:
                                        ing.unit_cost !== null
                                          ? `antes ${formatUnitCost(ing.unit_cost)}/${ing.base_unit}`
                                          : "sin precio anterior",
                                    }}
                                  />
                                ) : (
                                  <span className="text-muted">
                                    Captura precio y contenido. Se registra en el historial del
                                    insumo y la receta se recalcula.
                                  </span>
                                )}
                                {qp.error && (
                                  <span role="alert" className="block text-red-d">
                                    {qp.error}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </RowPair>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Lote</h3>
        <FormGrid cols={4}>
          <TextInput
            label="Rendimiento (piezas)"
            name="yield_qty"
            type="number"
            step="any"
            min={0.001}
            required
            value={yieldQty}
            onChange={(e) => setYieldQty(e.target.value)}
            disabled={!canWrite}
          />
          <TextInput
            label="Etiqueta"
            name="yield_label"
            maxLength={60}
            defaultValue={initial?.yield_label ?? ""}
            placeholder="12 piezas"
            disabled={!canWrite}
          />
          {perHour ? (
            <TextInput
              label="Mano de obra (minutos por lote)"
              name="labor_minutes"
              type="number"
              step="any"
              min={0}
              value={laborMinutes}
              onChange={(e) => setLaborMinutes(e.target.value)}
              disabled={!canWrite}
              placeholder="vacío = monto por lote"
              hint={`× ${fmtCents(settings.labor_rate_cents_per_hour)}/h (Configuración › Fórmulas)`}
            />
          ) : (
            <MoneyInput
              label="Mano de obra por lote"
              name="labor"
              value={labor}
              onChange={(e) => setLabor(e.target.value)}
              disabled={!canWrite}
            />
          )}
          {pctOverhead ? (
            <TextInput
              label="Indirectos"
              name="_overhead_readonly"
              value={b ? fmtCents(b.overhead.cents) : "—"}
              readOnly
              disabled
              hint={`${fmtPct(settings.overhead_pct_bps, 2)} de los insumos (Configuración › Fórmulas)`}
            />
          ) : (
            <MoneyInput
              label="Indirectos por lote"
              name="overhead"
              value={overhead}
              onChange={(e) => setOverhead(e.target.value)}
              disabled={!canWrite}
              hint="gas, luz, empaque…"
            />
          )}
        </FormGrid>
        {perHour && <input type="hidden" name="labor" value={labor} readOnly />}
        {pctOverhead && <input type="hidden" name="overhead" value={overhead} readOnly />}
        <div className="mt-3">
          <FormGrid cols={4}>
            <TextInput
              label="Merma / desperdicio (%)"
              name="waste_pct"
              type="number"
              step="any"
              min={0}
              max={100}
              value={wastePct}
              onChange={(e) => setWastePct(e.target.value)}
              disabled={!canWrite}
              placeholder={`default ${fmtPct(settings.default_waste_bps, 2)}`}
              hint="vacío = usa el default global"
            />
            <TextInput
              label="Margen objetivo (%)"
              name="target_margin_pct"
              type="number"
              step="any"
              min={0}
              max={99}
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              disabled={!canWrite}
              placeholder={`default ${fmtPct(settings.default_target_margin_bps, 0)}`}
              hint="vacío = usa el default global"
            />
          </FormGrid>
        </div>
        <div className="mt-3">
          <TextArea
            label="Notas / procedimiento"
            name="notes"
            rows={3}
            maxLength={1000}
            defaultValue={initial?.notes ?? ""}
            disabled={!canWrite}
          />
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="st-blue rounded-[var(--r-card)] px-4 py-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">
            Previsualización en vivo (fórmulas con tus cambios)
          </div>
          {b ? (
            <FormulaList
              className="mt-2"
              lines={formulaLines(b, { includeLines: false, channel: "both" })}
              ariaLive="polite"
            />
          ) : (
            <p className="mt-1 opacity-80">Escribe un rendimiento válido.</p>
          )}
          {b?.has_missing_prices && (
            <p className="mt-2 text-xs text-amber-d">
              Hay ingredientes sin precio: el costo real es mayor.
            </p>
          )}
        </div>
        <div className="card px-4 py-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">
            Costo guardado (SQL, la verdad)
          </div>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
            <dt>Costo por pieza</dt>
            <dd className="text-right text-base font-semibold" data-testid="sql-cost">
              {saved?.cost_per_piece_cents === null || saved?.cost_per_piece_cents === undefined
                ? "—"
                : formatMXN(saved.cost_per_piece_cents)}
            </dd>
            <dt>Precio POS vigente</dt>
            <dd className="text-right">
              {posPriceCents === null ? "—" : formatMXN(posPriceCents)}
            </dd>
            <dt>Margen POS</dt>
            <dd
              className={`text-right font-semibold ${savedTone === "red" ? "text-red-d" : savedTone === "amber" ? "text-amber-d" : savedTone === "green" ? "text-green-d" : ""}`}
            >
              {fmtPct(saved?.pos_margin_bps ?? null)}
              <span className="ml-1 text-xs font-normal text-muted">
                obj. {fmtPct(saved?.target_margin_bps ?? settings.default_target_margin_bps, 0)}
              </span>
            </dd>
            <dt>Precio sugerido</dt>
            <dd className="text-right font-semibold" data-testid="sql-suggested">
              {saved?.suggested_price_cents === null || saved?.suggested_price_cents === undefined
                ? "—"
                : formatMXN(saved.suggested_price_cents)}
            </dd>
          </dl>
          {saved && (
            <div className="mt-2">
              <FormulaList
                compact
                lines={formulaLines(saved, { includeLines: false, channel: "pos" }).filter((l) =>
                  ["cost", "Margen", "suggested"].includes(l.key),
                )}
              />
            </div>
          )}
          {canWritePrice &&
            saved?.suggested_price_cents !== null &&
            saved?.suggested_price_cents !== undefined && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm !min-h-11"
                  onClick={applySuggested}
                  disabled={applying || saved.suggested_price_cents === posPriceCents}
                  aria-busy={applying}
                  title="Crea un precio regular nuevo igual al sugerido (el anterior queda en el historial)"
                >
                  {applying
                    ? "Aplicando…"
                    : `Aplicar precio sugerido (${formatMXN(saved.suggested_price_cents)})`}
                </button>
                {applyMsg && (
                  <span role="status" className="text-xs">
                    {applyMsg}
                  </span>
                )}
              </div>
            )}
          {saved && preview && preview.b.cost_per_piece_cents !== saved.cost_per_piece_cents && (
            <p className="mt-2 text-xs text-muted">
              Guarda la receta para que el costo SQL refleje la previsualización.
            </p>
          )}
        </div>
      </section>

      {canWrite && (
        <div>
          <SubmitButton>Guardar receta</SubmitButton>
        </div>
      )}
    </ActionForm>
  );
}

function RowPair({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function safeCents(v: string): number {
  try {
    const c = toCents(v || "0");
    return Number.isFinite(c) && c >= 0 ? c : 0;
  } catch {
    return 0;
  }
}

function unitCostFor(priceCents: number, qty: number, unit: string, base: BaseUnit): number | null {
  try {
    const b = toBaseQty(qty, unit, base).qty;
    if (b <= 0) return null;
    return priceCents / 100 / b;
  } catch {
    return null;
  }
}
