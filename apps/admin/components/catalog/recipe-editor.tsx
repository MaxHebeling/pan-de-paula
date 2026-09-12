"use client";
import { useMemo, useState } from "react";
import { costRecipe, formatMXN, formatQty, marginBps, suggestedPrice, toBaseQty, toCents, type BaseUnit } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, SubmitButton } from "./action-form";
import { FormGrid, MoneyInput, TextArea, TextInput } from "./fields";
import { PURCHASE_UNITS, formatUnitCost } from "./units";

export type RecipeIngredient = { id: string; name: string; base_unit: BaseUnit; unit_cost: number | null; is_available: boolean };
export type RecipeLineInput = { ingredient_id: string; qty: number; note: string | null };
export type RecipeInitial = {
  yield_qty: number;
  yield_label: string | null;
  labor_cents: number;
  overhead_cents: number;
  notes: string | null;
  items: RecipeLineInput[];
};

type Line = { key: number; ingredient_id: string; qty: string; unit: string; note: string };

let seq = 1;

export function RecipeEditor({
  action,
  ingredients,
  initial,
  sqlCostCents,
  posPriceCents,
  canWrite,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  ingredients: RecipeIngredient[];
  initial: RecipeInitial | null;
  sqlCostCents: number | null;
  posPriceCents: number | null;
  canWrite: boolean;
}) {
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const [lines, setLines] = useState<Line[]>(() =>
    (initial?.items ?? []).map((it) => {
      const base = byId.get(it.ingredient_id)?.base_unit ?? "g";
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
  const [overhead, setOverhead] = useState(initial ? (initial.overhead_cents / 100).toFixed(2) : "0");
  const [targetMargin, setTargetMargin] = useState("60");
  const [adding, setAdding] = useState("");

  const preview = useMemo(() => {
    const y = Number(yieldQty);
    if (!Number.isFinite(y) || y <= 0) return null;
    const domainLines = lines.map((l) => {
      const ing = byId.get(l.ingredient_id);
      let baseQty = 0;
      try {
        baseQty = ing ? toBaseQty(Number(l.qty) || 0, l.unit, ing.base_unit).qty : 0;
      } catch {
        baseQty = 0;
      }
      return { ingredientId: l.ingredient_id, qty: baseQty, unitCost: ing?.unit_cost ?? null, key: l.key };
    });
    const laborC = safeCents(labor);
    const overheadC = safeCents(overhead);
    const c = costRecipe({ lines: domainLines, yieldQty: y, laborCents: laborC, overheadCents: overheadC });
    const margin = posPriceCents ? marginBps(posPriceCents, c.costPerPieceCents) : null;
    const tm = Math.min(99, Math.max(0, Number(targetMargin) || 0)) * 100;
    const suggested = c.costPerPieceCents > 0 ? suggestedPrice(c.costPerPieceCents, tm, 100) : null;
    const items = domainLines.filter((l) => l.ingredientId && l.qty > 0).map((l) => ({ ingredient_id: l.ingredientId, qty: l.qty, note: lines.find((x) => x.key === l.key)?.note || null }));
    return { ...c, margin, suggested, items, laborC, overheadC, y };
  }, [lines, yieldQty, labor, overhead, targetMargin, posPriceCents, byId]);

  const available = ingredients.filter((i) => !lines.some((l) => l.ingredient_id === i.id));

  function addLine(id: string) {
    const ing = byId.get(id);
    if (!ing) return;
    setLines((ls) => [...ls, { key: seq++, ingredient_id: id, qty: "", unit: ing.base_unit, note: "" }]);
    setAdding("");
  }
  function update(key: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function remove(key: number) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

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
              <select id="add-ingredient" className="input !w-64 !py-1.5 text-sm" value={adding} onChange={(e) => addLine(e.target.value)}>
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
            Sin líneas. Agrega los ingredientes con la cantidad que lleva <strong>un lote</strong> de la receta.
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
                  {canWrite && <th className="w-10" />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const ing = byId.get(l.ingredient_id);
                  const pl = preview?.lines.find((x) => x.ingredientId === l.ingredient_id);
                  return (
                    <tr key={l.key} className="border-t border-line">
                      <td>
                        <div className="font-medium">{ing?.name ?? "—"}</div>
                        {ing && ing.unit_cost === null && <span className="text-xs text-amber-d">sin precio: no suma al costo</span>}
                        {ing && !ing.is_available && <span className="text-xs text-muted"> · no disponible</span>}
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
                        <select id={`unit-${l.key}`} className="input !py-1.5" value={l.unit} onChange={(e) => update(l.key, { unit: e.target.value })} disabled={!canWrite}>
                          {(ing ? PURCHASE_UNITS[ing.base_unit] : []).map((u) => (
                            <option key={u.value} value={u.value}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="text-right tabular-nums text-muted">
                        {ing?.unit_cost === null || ing?.unit_cost === undefined ? "—" : `${formatUnitCost(ing.unit_cost)}/${ing.base_unit}`}
                      </td>
                      <td className="text-right tabular-nums">{pl?.cost === null || pl?.cost === undefined ? "—" : `$${pl.cost.toFixed(2)}`}</td>
                      <td>
                        <label htmlFor={`note-${l.key}`} className="sr-only">
                          Nota
                        </label>
                        <input id={`note-${l.key}`} className="input !py-1.5" maxLength={120} value={l.note} onChange={(e) => update(l.key, { note: e.target.value })} disabled={!canWrite} placeholder="opcional" />
                      </td>
                      {canWrite && (
                        <td>
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(l.key)} aria-label={`Quitar ${ing?.name}`}>
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
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
          <TextInput label="Rendimiento (piezas)" name="yield_qty" type="number" step="any" min={0.001} required value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} disabled={!canWrite} />
          <TextInput label="Etiqueta" name="yield_label" maxLength={60} defaultValue={initial?.yield_label ?? ""} placeholder="12 piezas" disabled={!canWrite} />
          <MoneyInput label="Mano de obra por lote" name="labor" value={labor} onChange={(e) => setLabor(e.target.value)} disabled={!canWrite} />
          <MoneyInput label="Indirectos por lote" name="overhead" value={overhead} onChange={(e) => setOverhead(e.target.value)} disabled={!canWrite} hint="gas, luz, empaque…" />
        </FormGrid>
        <div className="mt-3">
          <TextArea label="Notas / procedimiento" name="notes" rows={3} maxLength={1000} defaultValue={initial?.notes ?? ""} disabled={!canWrite} />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div className="st-blue rounded-[var(--r-card)] px-4 py-3 text-sm" aria-live="polite">
          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">Previsualización (en vivo)</div>
          {preview ? (
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <dt>Ingredientes por lote</dt>
              <dd className="text-right">${preview.ingredientsCost.toFixed(2)}</dd>
              <dt>Mano de obra + indirectos</dt>
              <dd className="text-right">{formatMXN(preview.laborC + preview.overheadC)}</dd>
              <dt>Rendimiento</dt>
              <dd className="text-right">{formatQty(preview.y, "pz")}</dd>
              <dt className="font-semibold">Costo por pieza</dt>
              <dd className="text-right text-base font-semibold">{formatMXN(preview.costPerPieceCents)}</dd>
              {preview.hasMissingPrices && <dd className="col-span-2 text-xs text-amber-d">Hay ingredientes sin precio: el costo real es mayor.</dd>}
            </dl>
          ) : (
            <p className="mt-1 opacity-80">Escribe un rendimiento válido.</p>
          )}
        </div>
        <div className="card px-4 py-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Costo guardado (SQL, la verdad)</div>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
            <dt>Costo por pieza</dt>
            <dd className="text-right text-base font-semibold" data-testid="sql-cost">
              {sqlCostCents === null ? "—" : formatMXN(sqlCostCents)}
            </dd>
            <dt>Precio POS vigente</dt>
            <dd className="text-right">{posPriceCents === null ? "—" : formatMXN(posPriceCents)}</dd>
            <dt>Margen (previsualizado)</dt>
            <dd className={`text-right font-semibold ${preview?.margin !== null && preview?.margin !== undefined && preview.margin < 3000 ? "text-red-d" : ""}`}>
              {preview?.margin === null || preview?.margin === undefined ? "—" : `${(preview.margin / 100).toFixed(1)}%`}
            </dd>
            <dt className="flex items-center gap-2">
              <label htmlFor="target-margin">Margen objetivo</label>
              <input id="target-margin" type="number" min={0} max={99} className="input !w-20 !py-1 text-right" value={targetMargin} onChange={(e) => setTargetMargin(e.target.value)} />%
            </dt>
            <dd className="text-right">
              {preview?.suggested ? (
                <>
                  sugerido <strong>{formatMXN(preview.suggested)}</strong>
                </>
              ) : (
                "—"
              )}
            </dd>
          </dl>
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

function safeCents(v: string): number {
  try {
    const c = toCents(v || "0");
    return Number.isFinite(c) && c >= 0 ? c : 0;
  } catch {
    return 0;
  }
}
