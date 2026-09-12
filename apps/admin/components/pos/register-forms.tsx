"use client";
import { useActionState, useState } from "react";
import { formatMXN } from "@pdp/domain";
import { closeRegisterAction, openRegisterAction, type RegisterActionState } from "@/app/(app)/caja/actions";
import { Numpad } from "./numpad";

export function RegisterOpenForm() {
  const [state, action, pending] = useActionState<RegisterActionState, FormData>(openRegisterAction, {});
  const [cents, setCents] = useState(0);
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2" data-testid="register-open-form">
      <input type="hidden" name="opening_cash_cents" value={cents} />
      <div className="flex flex-col gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Fondo inicial en efectivo</div>
          <div className="text-3xl font-semibold tabular-nums" data-testid="opening-cash">
            {formatMXN(cents)}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 50000, 100000].map((v) => (
            <button key={v} type="button" onClick={() => setCents(v)} className={`btn min-h-11 tabular-nums ${cents === v ? "btn-primary" : "btn-secondary"}`}>
              {formatMXN(v, { compact: true })}
            </button>
          ))}
        </div>
        <textarea name="notes" className="input min-h-20" placeholder="Observaciones (opcional)" maxLength={300} />
        {state.error && (
          <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
            {state.error}
          </p>
        )}
        <button className="btn btn-confirm btn-lg min-h-14" disabled={pending} data-testid="open-register">
          {pending ? "Abriendo…" : "Abrir caja"}
        </button>
      </div>
      <Numpad valueCents={cents} onChange={setCents} />
    </form>
  );
}

export function RegisterCloseForm({ sessionId, expectedCashCents }: { sessionId: string; expectedCashCents: number }) {
  const [state, action, pending] = useActionState<RegisterActionState, FormData>(closeRegisterAction, {});
  const [cents, setCents] = useState(0);
  const [touched, setTouched] = useState(false);
  const diff = cents - expectedCashCents;
  const tone = !touched ? "" : diff === 0 ? "st-green" : Math.abs(diff) <= 2000 ? "st-amber" : "st-red";
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2" data-testid="register-close-form">
      <input type="hidden" name="session_id" value={sessionId} />
      <input type="hidden" name="counted_cash_cents" value={cents} />
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="card p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Efectivo esperado</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid="expected-cash" data-cents={expectedCashCents}>
              {formatMXN(expectedCashCents)}
            </div>
          </div>
          <div className="card p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Contado</div>
            <div className="text-2xl font-semibold tabular-nums" data-testid="counted-cash">
              {formatMXN(cents)}
            </div>
          </div>
        </div>
        <div className={`card p-3 ${tone}`}>
          <div className="text-xs font-medium uppercase tracking-wide opacity-70">Diferencia</div>
          <div className="text-3xl font-semibold tabular-nums" data-testid="difference">
            {touched ? `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${formatMXN(Math.abs(diff))}` : "—"}
          </div>
          {touched && diff !== 0 && <div className="text-xs">{diff > 0 ? "Sobra efectivo" : "Falta efectivo"}: revisa antes de cerrar.</div>}
        </div>
        <button type="button" className="btn btn-secondary min-h-11" onClick={() => { setCents(expectedCashCents); setTouched(true); }}>
          Usar el esperado ({formatMXN(expectedCashCents)})
        </button>
        <textarea name="notes" className="input min-h-20" placeholder="Observaciones del cierre (opcional)" maxLength={500} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" className="h-5 w-5" required /> Confirmo el conteo; el cierre no se puede deshacer
        </label>
        {state.error && (
          <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
            {state.error}
          </p>
        )}
        <button className="btn btn-danger btn-lg min-h-14" disabled={pending || !touched} data-testid="close-register">
          {pending ? "Cerrando…" : "Cerrar caja"}
        </button>
      </div>
      <Numpad
        valueCents={cents}
        onChange={(v) => {
          setCents(v);
          setTouched(true);
        }}
      />
    </form>
  );
}
