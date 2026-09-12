"use client";
import { useActionState } from "react";
import type { ActionState } from "@/lib/action-state";

/** Genera un lote de códigos a partir de un cupón base y los muestra para copiar. */
export function CodesGenerator({
  action,
  couponId,
  defaultPrefix,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  couponId: string;
  defaultPrefix: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const codes = (state.data?.codes as string[] | undefined) ?? [];
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={couponId} />
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label" htmlFor="gen_prefix">
            Prefijo
          </label>
          <input
            id="gen_prefix"
            name="prefix"
            className="input font-mono uppercase"
            defaultValue={defaultPrefix}
            required
            pattern="[A-Za-z0-9]{2,12}"
          />
        </div>
        <div>
          <label className="label" htmlFor="gen_count">
            Cantidad
          </label>
          <input
            id="gen_count"
            name="count"
            type="number"
            min={1}
            max={200}
            className="input"
            defaultValue={10}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="gen_max">
            Usos por código
          </label>
          <input
            id="gen_max"
            name="max_uses"
            type="number"
            min={1}
            className="input"
            defaultValue={1}
            required
          />
        </div>
      </div>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      {state.ok && (
        <div className="st-green rounded-[var(--r-btn)] px-3 py-2 text-sm">
          <p role="status">{state.ok}</p>
          {codes.length > 0 && (
            <textarea
              readOnly
              className="input mt-2 h-32 font-mono text-xs"
              value={codes.join("\n")}
              aria-label="Códigos generados"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      )}
      <button className="btn btn-secondary" disabled={pending}>
        {pending ? "Generando…" : "Generar códigos"}
      </button>
    </form>
  );
}
