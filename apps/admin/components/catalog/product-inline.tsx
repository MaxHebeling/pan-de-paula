"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { marginTone, previewBreakdown, type Breakdown } from "./costing-types";
import { fmtCents, fmtPct, formulaLines } from "./formula-lines";
import { FormulaList } from "./formula";
import { InlineCell, InlineToggle } from "./inline-cell";

export type ProductFlagName =
  "is_active" | "show_on_web" | "show_on_pos" | "is_featured" | "pos_favorite";

/** Celdas de precio POS/web + costo/margen con recálculo en vivo y fórmula al expandir (lista de productos). */
export function ProductCostCells({
  productId,
  name,
  breakdown: initial,
  canWrite,
  setPrice,
}: {
  productId: string;
  name: string;
  breakdown: Breakdown;
  canWrite: boolean;
  setPrice: (id: string, channel: "pos" | "web", cents: unknown) => Promise<ActionState>;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<{ pos?: number | null; web?: number | null }>({});
  const [open, setOpen] = useState(false);
  const isPreview = draft.pos !== undefined || draft.web !== undefined;
  const b = isPreview
    ? previewBreakdown(saved, {
        ...(draft.pos !== undefined ? { pos_price_cents: draft.pos } : {}),
        ...(draft.web !== undefined ? { web_price_cents: draft.web } : {}),
      })
    : saved;
  const tone = marginTone(b.pos_margin_bps, b.target_margin_bps);
  const prev = isPreview ? "cell-preview" : "";
  async function save(channel: "pos" | "web", v: unknown) {
    const r = await setPrice(productId, channel, v);
    const nb = r.data?.breakdown as Breakdown | undefined;
    if (nb) setSaved(nb);
    if (!r.error) router.refresh();
    return r;
  }
  return (
    <>
      <td>
        <InlineCell
          kind="money"
          value={saved.pos_price_cents}
          min={0}
          label={`Precio POS de ${name}`}
          display={fmtCents(saved.pos_price_cents)}
          hint="crea un precio regular nuevo (POS)"
          disabled={!canWrite}
          onDraft={(v) =>
            setDraft((d) => ({ ...d, pos: v === undefined ? undefined : (v as number | null) }))
          }
          onSave={(v) => save("pos", v)}
          testId={`prod-pos-${productId}`}
        />
      </td>
      <td>
        <InlineCell
          kind="money"
          value={saved.web_price_cents}
          min={0}
          label={`Precio web de ${name}`}
          display={fmtCents(saved.web_price_cents)}
          hint="crea un precio regular nuevo (web)"
          disabled={!canWrite}
          onDraft={(v) =>
            setDraft((d) => ({ ...d, web: v === undefined ? undefined : (v as number | null) }))
          }
          onSave={(v) => save("web", v)}
          testId={`prod-web-${productId}`}
        />
      </td>
      <td className="text-right">
        {b.has_recipe ? (
          <>
            <span className={`tabular-nums ${prev}`}>{fmtCents(b.cost_per_piece_cents)}</span>
            <div>
              <button
                type="button"
                className="min-h-11 text-xs text-teal-d hover:underline"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
              >
                {open ? "▾" : "▸"} fórmula
              </button>
            </div>
          </>
        ) : (
          <a href={`/recetas/${productId}`} className="text-xs text-teal-d hover:underline">
            sin receta
          </a>
        )}
      </td>
      <td className="text-right">
        <span
          className={`pill inline-flex min-w-14 justify-center px-2 py-0.5 text-xs font-semibold tabular-nums st-${tone} ${prev}`}
          title={
            b.pos_margin_bps === null
              ? undefined
              : `(${fmtCents(b.pos_price_cents)} − ${fmtCents(b.cost_per_piece_cents)}) ÷ ${fmtCents(b.pos_price_cents)} · objetivo ${fmtPct(b.target_margin_bps, 0)}`
          }
        >
          {fmtPct(b.pos_margin_bps)}
        </span>
        {open && b.has_recipe && (
          <div className="mt-1 w-[28rem] max-w-[70vw] rounded-[var(--r-card)] bg-black/[0.03] px-3 py-2 text-left">
            <FormulaList compact lines={formulaLines(b, { channel: "both" })} className={prev} />
          </div>
        )}
      </td>
    </>
  );
}

const FLAG_LABEL: Record<ProductFlagName, [string, string]> = {
  is_active: ["Activo", "Inactivo"],
  show_on_web: ["Web", "Web"],
  show_on_pos: ["POS", "POS"],
  is_featured: ["Destacado", "Destacado"],
  pos_favorite: ["Fav. POS", "Fav. POS"],
};

export function ProductFlags({
  productId,
  name,
  flags,
  canWrite,
  setFlag,
}: {
  productId: string;
  name: string;
  flags: Record<ProductFlagName, boolean>;
  canWrite: boolean;
  setFlag: (id: string, flag: ProductFlagName, value: boolean) => Promise<ActionState>;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap gap-1">
      {(Object.keys(FLAG_LABEL) as ProductFlagName[]).map((f) => (
        <InlineToggle
          key={f}
          checked={flags[f]}
          label={`${FLAG_LABEL[f][0]} · ${name}`}
          onLabel={FLAG_LABEL[f][0]}
          offLabel={FLAG_LABEL[f][1]}
          disabled={!canWrite}
          testId={`flag-${f}-${productId}`}
          onToggle={async (v) => {
            const r = await setFlag(productId, f, v);
            if (!r.error) router.refresh();
            return r;
          }}
        />
      ))}
    </div>
  );
}
