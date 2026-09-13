"use client";
import { useMemo, useState } from "react";
import { marginBps, toCents } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, SubmitButton } from "./action-form";
import { FormGrid, MoneyInput, Select, TextInput } from "./fields";
import { Formula } from "./formula";
import { fmtCents, marginFormula, suggestedFormula } from "./formula-lines";

/** Nuevo precio regular con margen calculado en vivo y botón "usar sugerido". */
export function RegularPriceForm({
  action,
  costCents,
  suggestedCents,
  suggestedRawCents,
  targetMarginBps,
  roundingCents,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  costCents: number | null;
  suggestedCents: number | null;
  suggestedRawCents: number | null;
  targetMarginBps: number;
  roundingCents: number;
}) {
  const [price, setPrice] = useState("");
  const live = useMemo(() => {
    const n = Number(price);
    if (!price || !Number.isFinite(n) || n < 0) return null;
    const cents = toCents(n);
    const margin = costCents === null ? null : marginBps(cents, costCents);
    return { cents, margin };
  }, [price, costCents]);

  return (
    <ActionForm action={action} resetOnSuccess className="flex flex-col gap-3">
      <FormGrid>
        <Select
          label="Canal"
          name="channel"
          id="reg-channel"
          defaultValue="all"
          hint="El precio del canal específico gana al de 'Todos'."
        >
          <option value="all">Todos los canales</option>
          <option value="pos">Solo POS</option>
          <option value="web">Solo tienda web</option>
        </Select>
        <MoneyInput
          label="Precio (MXN)"
          name="price"
          id="reg-price"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </FormGrid>
      <TextInput
        label="Motivo / etiqueta (opcional)"
        name="label"
        id="reg-label"
        maxLength={80}
        placeholder="Ajuste por inflación"
      />
      <div className="st-blue rounded-[var(--r-card)] px-3 py-2 text-sm" aria-live="polite">
        {costCents === null ? (
          <span className="opacity-80">Sin receta: no hay costo para calcular el margen.</span>
        ) : live ? (
          <Formula
            compact
            line={marginFormula(
              live.cents,
              costCents,
              live.margin,
              targetMarginBps,
              "Margen con este precio",
            )}
          />
        ) : (
          <span className="opacity-80">
            Escribe un precio para ver el margen: (precio − {fmtCents(costCents)}) ÷ precio.
          </span>
        )}
        {suggestedCents !== null && (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <Formula
              compact
              line={suggestedFormula(
                costCents,
                targetMarginBps,
                roundingCents,
                suggestedRawCents,
                suggestedCents,
              )}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm !min-h-11"
              onClick={() => setPrice((suggestedCents / 100).toFixed(2))}
              data-testid="use-suggested"
            >
              Usar sugerido ({fmtCents(suggestedCents)})
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        Cierra el precio regular vigente del mismo canal (valid_to = ahora) y activa el nuevo. Las
        ventas pasadas no cambian.
      </p>
      <div>
        <SubmitButton>Fijar precio</SubmitButton>
      </div>
    </ActionForm>
  );
}
