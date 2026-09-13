"use client";
import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { csvCell } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import {
  marginTone,
  previewBreakdown,
  type Breakdown,
  type BreakdownPatch,
  type BreakdownSettings,
} from "./costing-types";
import { fmtCents, fmtMxn, fmtNum, fmtPct, formulaLines, formulaText } from "./formula-lines";
import { FormulaList } from "./formula";
import { InlineCell, type CellValue } from "./inline-cell";

export type SheetRow = {
  product_id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  breakdown: Breakdown;
};

export type SheetActions = {
  updateParams: (productId: string, patch: unknown) => Promise<ActionState>;
  setPrice: (productId: string, channel: "pos" | "web", cents: unknown) => Promise<ActionState>;
  applySuggested: (productId: string) => Promise<ActionState>;
};

type Filter = "todos" | "bajo-objetivo" | "negativo" | "sin-precio-insumo" | "sin-receta";

const TONE_CLS = {
  green: "st-green",
  amber: "st-amber",
  red: "st-red",
  gray: "st-gray",
} as const;

export function CostSheet({
  rows: initialRows,
  categories,
  settings,
  canEditRecipe,
  canEditPrice,
  actions,
}: {
  rows: SheetRow[];
  categories: Array<{ id: string; name: string }>;
  settings: BreakdownSettings;
  canEditRecipe: boolean;
  canEditPrice: boolean;
  actions: SheetActions;
}) {
  const [rows, setRows] = useState(initialRows);
  const [drafts, setDrafts] = useState<Record<string, BreakdownPatch>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [notice, setNotice] = useState<string>("");
  const [applying, setApplying] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const liveRef = useRef<HTMLParagraphElement>(null);

  const perHour = settings.labor_mode === "per_hour";
  const pctOverhead = settings.overhead_mode === "pct_of_ingredients";

  function announce(msg: string) {
    setNotice(msg);
  }
  function mergeRow(productId: string, r: ActionState) {
    const b = r.data?.breakdown as Breakdown | undefined;
    if (b)
      setRows((rs) => rs.map((x) => (x.product_id === productId ? { ...x, breakdown: b } : x)));
    return b;
  }
  function setDraft(productId: string, key: keyof BreakdownPatch, v: CellValue | undefined) {
    setDrafts((d) => {
      const cur = { ...(d[productId] ?? {}) };
      if (v === undefined) delete cur[key];
      else (cur as Record<string, unknown>)[key] = v;
      const next = { ...d };
      if (Object.keys(cur).length === 0) delete next[productId];
      else next[productId] = cur;
      return next;
    });
  }
  async function saveParam(row: SheetRow, patch: BreakdownPatch): Promise<ActionState> {
    const r = await actions.updateParams(row.product_id, patch);
    const b = mergeRow(row.product_id, r);
    if (r.ok && b)
      announce(
        `${row.name}: costo por pieza ${fmtCents(b.cost_per_piece_cents)}, sugerido ${fmtCents(b.suggested_price_cents)}.`,
      );
    return r;
  }
  async function savePrice(
    row: SheetRow,
    channel: "pos" | "web",
    v: CellValue,
  ): Promise<ActionState> {
    const r = await actions.setPrice(row.product_id, channel, v);
    const b = mergeRow(row.product_id, r);
    if (r.ok && b)
      announce(
        `${row.name}: precio ${channel === "pos" ? "POS" : "web"} ${fmtCents(channel === "pos" ? b.pos_price_cents : b.web_price_cents)}, margen ${fmtPct(channel === "pos" ? b.pos_margin_bps : b.web_margin_bps)}.`,
      );
    return r;
  }
  function applySuggested(row: SheetRow) {
    setApplying(row.product_id);
    startTransition(async () => {
      const r = await actions.applySuggested(row.product_id);
      mergeRow(row.product_id, r);
      announce(r.error ? `${row.name}: ${r.error}` : `${row.name}: ${r.ok ?? "precio aplicado"}`);
      setApplying(null);
    });
  }
  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (needle && !r.name.toLowerCase().includes(needle)) return false;
      if (cat && r.category_id !== cat) return false;
      const b = r.breakdown;
      switch (filter) {
        case "bajo-objetivo":
          return b.pos_margin_bps !== null && b.pos_margin_bps < b.target_margin_bps;
        case "negativo":
          return b.pos_margin_bps !== null && b.pos_margin_bps < 0;
        case "sin-precio-insumo":
          return b.has_missing_prices;
        case "sin-receta":
          return !b.has_recipe;
        default:
          return true;
      }
    });
  }, [rows, q, cat, filter]);

  const totals = useMemo(() => {
    const withRecipe = visible.filter((r) => r.breakdown.has_recipe);
    const margins = withRecipe
      .map((r) => r.breakdown.pos_margin_bps)
      .filter((m): m is number => m !== null);
    const sum = (f: (b: Breakdown) => number | null) =>
      withRecipe.reduce((a, r) => a + (f(r.breakdown) ?? 0), 0);
    return {
      products: visible.length,
      withRecipe: withRecipe.length,
      ingredients: sum((b) => b.ingredients_mxn * 100),
      labor: sum((b) => b.labor.cents),
      overhead: sum((b) => b.overhead.cents),
      avgCost: withRecipe.length ? sum((b) => b.cost_per_piece_cents) / withRecipe.length : null,
      avgMargin: margins.length ? margins.reduce((a, m) => a + m, 0) / margins.length : null,
      underTarget: withRecipe.filter(
        (r) =>
          r.breakdown.pos_margin_bps !== null &&
          r.breakdown.pos_margin_bps < r.breakdown.target_margin_bps,
      ).length,
      negative: withRecipe.filter((r) => (r.breakdown.pos_margin_bps ?? 0) < 0).length,
    };
  }, [visible]);

  function exportCsv() {
    const head = [
      "Producto",
      "Categoría",
      "Ingredientes ($/lote)",
      "Mano de obra ($/lote)",
      "Indirectos ($/lote)",
      "Rendimiento",
      "Merma %",
      "Costo por pieza",
      "Precio POS",
      "Precio web",
      "Margen POS %",
      "Margen web %",
      "Margen objetivo %",
      "Precio sugerido",
      "Insumos sin precio",
      "Fórmulas",
    ];
    const num = (c: number | null | undefined, div = 100) =>
      c === null || c === undefined ? "" : (c / div).toFixed(2);
    // Todas las celdas entre comillas y protegidas contra inyección de fórmulas al abrir en Excel
    const esc = (v: string | number) => csvCell(v, /[\s\S]/);
    const lines = visible.map((r) => {
      const b = r.breakdown;
      return [
        r.name,
        r.category_name ?? "",
        b.has_recipe ? b.ingredients_mxn.toFixed(2) : "",
        num(b.labor.cents),
        num(b.overhead.cents),
        b.yield_qty ?? "",
        b.has_recipe ? num(b.waste_bps) : "",
        num(b.cost_per_piece_cents),
        num(b.pos_price_cents),
        num(b.web_price_cents),
        num(b.pos_margin_bps),
        num(b.web_margin_bps),
        num(b.target_margin_bps),
        num(b.suggested_price_cents),
        b.has_missing_prices ? "sí" : "no",
        formulaText(formulaLines(b, { channel: "both" })),
      ]
        .map(esc)
        .join(",");
    });
    const csv = "﻿" + [head.map(esc).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hoja-de-costos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="sheet-q" className="label">
            Buscar producto
          </label>
          <input
            id="sheet-q"
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Croissant…"
            autoComplete="off"
          />
        </div>
        <div className="min-w-40">
          <label htmlFor="sheet-cat" className="label">
            Categoría
          </label>
          <select
            id="sheet-cat"
            className="input"
            value={cat}
            onChange={(e) => setCat(e.target.value)}
          >
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-44">
          <label htmlFor="sheet-filter" className="label">
            Mostrar
          </label>
          <select
            id="sheet-filter"
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="todos">Todos</option>
            <option value="bajo-objetivo">Margen bajo el objetivo</option>
            <option value="negativo">Margen negativo</option>
            <option value="sin-precio-insumo">Con insumos sin precio</option>
            <option value="sin-receta">Sin receta</option>
          </select>
        </div>
        <button type="button" className="btn btn-secondary" onClick={exportCsv}>
          Exportar CSV
        </button>
      </div>

      <p className="text-xs text-muted">
        Clic (o Enter) en una celda para editar · <kbd>Enter</kbd> guarda · <kbd>Esc</kbd> cancela ·{" "}
        <kbd>Tab</kbd> siguiente celda. El servidor recalcula todo al guardar; mientras escribes ves
        una vista previa <span className="cell-preview">en cursiva</span>.
      </p>
      <p ref={liveRef} role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>

      <div className="card overflow-x-auto">
        <table
          className="w-full min-w-[1180px] text-sm [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted [&_tbody_tr]:border-t [&_tbody_tr]:border-line"
          data-testid="cost-sheet"
        >
          <thead>
            <tr>
              <th className="min-w-52">Producto</th>
              <th
                className="text-right"
                title="Suma de qty × costo unitario de cada insumo, por lote"
              >
                Ingredientes ($)
              </th>
              <th
                className="text-right"
                title={perHour ? "Minutos por lote × tarifa por hora" : "Monto por lote"}
              >
                MO{perHour ? " (min)" : ""}
              </th>
              <th
                className="text-right"
                title={pctOverhead ? "% de los insumos" : "Monto por lote"}
              >
                Indirectos{pctOverhead ? ` (${fmtPct(settings.overhead_pct_bps, 2)})` : ""}
              </th>
              <th className="text-right">Rendimiento</th>
              <th className="text-right" title="Vacío = usa el default global">
                Merma %
              </th>
              <th className="text-right">Costo/pieza</th>
              <th className="text-right">Precio POS</th>
              <th className="text-right">Precio web</th>
              <th className="text-right">Margen</th>
              <th className="text-right" title="Vacío = usa el default global">
                Margen obj.
              </th>
              <th className="text-right">Sugerido</th>
              <th className="text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={13} className="py-8 text-center text-muted">
                  Ningún producto coincide.
                </td>
              </tr>
            )}
            {visible.map((row) => {
              const draft = drafts[row.product_id];
              const isPreview = !!draft && Object.keys(draft).length > 0;
              // `s` = guardado (SQL): es lo que edita cada celda. `b` = previsualización mientras se escribe.
              const s = row.breakdown;
              const b = isPreview ? previewBreakdown(s, draft) : s;
              const tone = marginTone(b.pos_margin_bps, b.target_margin_bps);
              const prev = isPreview ? "cell-preview" : "";
              const open = expanded.has(row.product_id);
              const canRecipe = canEditRecipe;
              const suggestedApplied =
                b.suggested_price_cents !== null && b.suggested_price_cents === b.pos_price_cents;
              return (
                <RowGroup key={row.product_id} open={open}>
                  <tr data-testid={`sheet-row-${row.product_id}`} data-product-name={row.name}>
                    <td>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm !min-h-11 !px-2"
                          aria-expanded={open}
                          aria-label={`${open ? "Ocultar" : "Ver"} fórmulas de ${row.name}`}
                          onClick={() => toggleExpanded(row.product_id)}
                        >
                          <span
                            aria-hidden
                            className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
                          >
                            ▸
                          </span>
                        </button>
                        <div className="min-w-0">
                          <Link
                            href={`/recetas/${row.product_id}`}
                            className="font-medium hover:underline"
                          >
                            {row.name}
                          </Link>
                          <div className="flex flex-wrap gap-1 text-xs text-muted">
                            <span>{row.category_name ?? ""}</span>
                            {!b.has_recipe && (
                              <span className="st-amber pill px-1.5">sin receta</span>
                            )}
                            {b.has_recipe && b.lines.length === 0 && (
                              <span className="st-amber pill px-1.5">sin ingredientes</span>
                            )}
                            {b.has_missing_prices && (
                              <span className="st-amber pill px-1.5">insumo sin precio</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={`text-right tabular-nums ${prev}`}>
                      {b.has_recipe ? fmtMxn(b.ingredients_mxn) : "—"}
                    </td>
                    <td>
                      {perHour ? (
                        <InlineCell
                          kind="number"
                          value={s.labor.minutes}
                          nullable
                          min={0}
                          label={`Minutos de mano de obra de ${row.name}`}
                          display={
                            b.labor.minutes === null ? (
                              <span>
                                {fmtCents(b.labor.cents)}{" "}
                                <span className="text-xs text-muted">lote</span>
                              </span>
                            ) : (
                              <span>
                                {fmtNum(b.labor.minutes, 2)} min{" "}
                                <span className="text-xs text-muted">
                                  = {fmtCents(b.labor.cents)}
                                </span>
                              </span>
                            )
                          }
                          hint={`× ${fmtCents(settings.labor_rate_cents_per_hour)}/h · vacío = monto por lote`}
                          disabled={!canRecipe}
                          onDraft={(v) => setDraft(row.product_id, "labor_minutes", v)}
                          onSave={(v) => saveParam(row, { labor_minutes: v as number | null })}
                          testId={`cell-labor-${row.product_id}`}
                        />
                      ) : (
                        <InlineCell
                          kind="money"
                          value={s.labor.per_batch_cents ?? 0}
                          min={0}
                          label={`Mano de obra por lote de ${row.name}`}
                          display={fmtCents(b.labor.per_batch_cents ?? 0)}
                          disabled={!canRecipe}
                          onDraft={(v) => setDraft(row.product_id, "labor_cents", v)}
                          onSave={(v) => saveParam(row, { labor_cents: v as number })}
                          testId={`cell-labor-${row.product_id}`}
                        />
                      )}
                    </td>
                    <td>
                      {pctOverhead ? (
                        <span
                          className={`inline-cell inline-cell-ro ${prev}`}
                          aria-label="Indirectos calculados como % de insumos"
                        >
                          {b.has_recipe ? fmtCents(b.overhead.cents) : "—"}
                        </span>
                      ) : (
                        <InlineCell
                          kind="money"
                          value={s.overhead.fixed_cents ?? 0}
                          min={0}
                          label={`Indirectos por lote de ${row.name}`}
                          display={fmtCents(b.overhead.fixed_cents ?? 0)}
                          disabled={!canRecipe}
                          onDraft={(v) => setDraft(row.product_id, "overhead_cents", v)}
                          onSave={(v) => saveParam(row, { overhead_cents: v as number })}
                          testId={`cell-overhead-${row.product_id}`}
                        />
                      )}
                    </td>
                    <td>
                      <InlineCell
                        kind="number"
                        value={s.yield_qty}
                        min={0.001}
                        step="any"
                        label={`Rendimiento de ${row.name}`}
                        display={b.yield_qty === null ? "—" : fmtNum(b.yield_qty)}
                        disabled={!canRecipe}
                        onDraft={(v) => setDraft(row.product_id, "yield_qty", v)}
                        onSave={(v) => saveParam(row, { yield_qty: v as number })}
                        testId={`cell-yield-${row.product_id}`}
                      />
                    </td>
                    <td>
                      <InlineCell
                        kind="percent"
                        value={s.recipe_waste_bps}
                        nullable
                        min={0}
                        max={100}
                        label={`Merma de ${row.name} en porcentaje`}
                        display={
                          <span>
                            {fmtPct(b.waste_bps, 2)}
                            {b.waste_source === "default" && (
                              <span className="text-xs text-muted"> def.</span>
                            )}
                          </span>
                        }
                        hint={`vacío = default ${fmtPct(settings.default_waste_bps, 2)}`}
                        disabled={!canRecipe}
                        onDraft={(v) => setDraft(row.product_id, "waste_bps", v)}
                        onSave={(v) => saveParam(row, { waste_bps: v as number | null })}
                        testId={`cell-waste-${row.product_id}`}
                      />
                    </td>
                    <td
                      className={`text-right font-semibold tabular-nums ${prev}`}
                      data-testid={`cell-cost-${row.product_id}`}
                    >
                      {fmtCents(b.cost_per_piece_cents)}
                    </td>
                    <td>
                      <InlineCell
                        kind="money"
                        value={s.pos_price_cents}
                        min={0}
                        label={`Precio POS de ${row.name}`}
                        display={fmtCents(b.pos_price_cents)}
                        hint="crea un precio regular nuevo (POS)"
                        disabled={!canEditPrice}
                        onDraft={(v) => setDraft(row.product_id, "pos_price_cents", v)}
                        onSave={(v) => savePrice(row, "pos", v)}
                        testId={`cell-pos-${row.product_id}`}
                      />
                    </td>
                    <td>
                      <InlineCell
                        kind="money"
                        value={s.web_price_cents}
                        min={0}
                        label={`Precio web de ${row.name}`}
                        display={fmtCents(b.web_price_cents)}
                        hint="crea un precio regular nuevo (web)"
                        disabled={!canEditPrice}
                        onDraft={(v) => setDraft(row.product_id, "web_price_cents", v)}
                        onSave={(v) => savePrice(row, "web", v)}
                        testId={`cell-web-${row.product_id}`}
                      />
                    </td>
                    <td className="text-right">
                      <span
                        className={`${TONE_CLS[tone]} pill inline-flex min-w-16 justify-center px-2 py-0.5 text-xs font-semibold tabular-nums ${prev}`}
                        title={
                          b.pos_margin_bps === null
                            ? "sin precio o sin costo"
                            : `(${fmtCents(b.pos_price_cents)} − ${fmtCents(b.cost_per_piece_cents)}) ÷ ${fmtCents(b.pos_price_cents)}`
                        }
                        data-testid={`cell-margin-${row.product_id}`}
                      >
                        {fmtPct(b.pos_margin_bps)}
                      </span>
                      {b.web_margin_bps !== null && b.web_margin_bps !== b.pos_margin_bps && (
                        <div className="text-[11px] text-muted">web {fmtPct(b.web_margin_bps)}</div>
                      )}
                    </td>
                    <td>
                      <InlineCell
                        kind="percent"
                        value={s.recipe_target_margin_bps}
                        nullable
                        min={0}
                        max={99}
                        label={`Margen objetivo de ${row.name} en porcentaje`}
                        display={
                          <span>
                            {fmtPct(b.target_margin_bps, 0)}
                            {b.target_source === "default" && (
                              <span className="text-xs text-muted"> def.</span>
                            )}
                          </span>
                        }
                        hint={`vacío = default ${fmtPct(settings.default_target_margin_bps, 0)}`}
                        disabled={!canRecipe}
                        onDraft={(v) => setDraft(row.product_id, "target_margin_bps", v)}
                        onSave={(v) => saveParam(row, { target_margin_bps: v as number | null })}
                        testId={`cell-target-${row.product_id}`}
                      />
                    </td>
                    <td
                      className={`text-right font-medium tabular-nums ${prev}`}
                      title={
                        b.suggested_raw_cents === null
                          ? undefined
                          : `${fmtCents(b.cost_per_piece_cents)} ÷ (1 − ${fmtPct(b.target_margin_bps, 0)}) = ${fmtCents(b.suggested_raw_cents)}`
                      }
                      data-testid={`cell-suggested-${row.product_id}`}
                    >
                      {fmtCents(b.suggested_price_cents)}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        {canEditPrice && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm !min-h-11 whitespace-nowrap"
                            disabled={
                              b.suggested_price_cents === null ||
                              suggestedApplied ||
                              applying === row.product_id
                            }
                            aria-busy={applying === row.product_id}
                            title={
                              suggestedApplied
                                ? "El precio POS ya es el sugerido"
                                : `Fijar precio regular = ${fmtCents(b.suggested_price_cents)}`
                            }
                            onClick={() => applySuggested(row)}
                            data-testid={`apply-${row.product_id}`}
                          >
                            {applying === row.product_id ? "Aplicando…" : "Aplicar sugerido"}
                          </button>
                        )}
                        <Link
                          href={`/recetas/${row.product_id}`}
                          className="btn btn-secondary btn-sm !min-h-11"
                        >
                          Receta
                        </Link>
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="!border-t-0 bg-black/[0.02]">
                      <td colSpan={13} className="!py-2">
                        <FormulaList
                          lines={formulaLines(b, { includeLines: true, channel: "both" })}
                          compact
                          className={isPreview ? "cell-preview" : ""}
                        />
                      </td>
                    </tr>
                  )}
                </RowGroup>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line bg-black/[0.02] font-medium">
              <td>
                {totals.products} productos · {totals.withRecipe} con receta
                {totals.underTarget > 0 && (
                  <span className="st-amber pill ml-2 px-2 py-0.5 text-xs">
                    {totals.underTarget} bajo objetivo
                  </span>
                )}
                {totals.negative > 0 && (
                  <span className="st-red pill ml-1 px-2 py-0.5 text-xs">
                    {totals.negative} negativos
                  </span>
                )}
              </td>
              <td className="text-right tabular-nums" title="Suma por lote">
                Σ {fmtCents(totals.ingredients)}
              </td>
              <td className="text-right tabular-nums">Σ {fmtCents(totals.labor)}</td>
              <td className="text-right tabular-nums">Σ {fmtCents(totals.overhead)}</td>
              <td />
              <td />
              <td className="text-right tabular-nums" title="Promedio">
                ⌀ {fmtCents(totals.avgCost)}
              </td>
              <td />
              <td />
              <td className="text-right tabular-nums" title="Promedio">
                ⌀ {fmtPct(totals.avgMargin)}
              </td>
              <td className="text-right tabular-nums text-muted">
                {fmtPct(settings.default_target_margin_bps, 0)} def.
              </td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Agrupa la fila y su desglose (React necesita un solo hijo con key por producto). */
function RowGroup({ children }: { children: React.ReactNode; open: boolean }) {
  return <>{children}</>;
}
