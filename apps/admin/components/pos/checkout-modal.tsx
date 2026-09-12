"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Banknote,
  CreditCard,
  Landmark,
  QrCode,
  Smartphone,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { changeDue, formatMXN, PAYMENT_METHOD_LABELS, quickTenderOptions } from "@pdp/domain";
import { MpPayment, type MpHandlers } from "./mp-payment";
import { Numpad } from "./numpad";
import type { CheckoutPayment, PosConfig } from "./types";

type Tab = "cash" | "card_terminal" | "transfer" | "mp_point" | "mp_qr" | "split";

export type CheckoutModalProps = {
  open: boolean;
  totalCents: number;
  config: PosConfig;
  onClose: () => void;
  onSubmit: (payments: CheckoutPayment[]) => Promise<{ ok: true } | { ok: false; error: string }>;
  mp: MpHandlers;
};

type SplitPart = {
  method: "cash" | "card_terminal" | "transfer";
  amount: number;
  tendered?: number;
  reference?: string;
};

const manual = (
  method: "card_terminal" | "transfer",
  amount: number,
  reference: string,
): CheckoutPayment => ({
  provider: "manual",
  method,
  amount_cents: amount,
  ...(reference.trim() ? { reference: reference.trim() } : {}),
});
const cash = (amount: number, tendered: number): CheckoutPayment => ({
  provider: "cash",
  method: "cash",
  amount_cents: amount,
  tendered_cents: Math.max(tendered, amount),
});

/** Se monta solo mientras está abierto: cada apertura arranca con estado limpio (sin efectos de reseteo). */
export function CheckoutModal(props: CheckoutModalProps) {
  if (!props.open) return null;
  return <CheckoutDialog {...props} />;
}

function CheckoutDialog({ totalCents, config, onClose, onSubmit, mp }: CheckoutModalProps) {
  const registerOpen = Boolean(config.register);
  const [tab, setTab] = useState<Tab>(registerOpen ? "cash" : "card_terminal");
  const [tendered, setTendered] = useState(0);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [partMethod, setPartMethod] = useState<SplitPart["method"]>(
    registerOpen ? "cash" : "card_terminal",
  );
  const [partAmount, setPartAmount] = useState(0);
  const [partReference, setPartReference] = useState("");

  const mpPoint = config.flags.mercadopago_point;
  const mpQr = config.flags.mercadopago_qr;
  const zero = totalCents === 0;

  const quick = useMemo(() => quickTenderOptions(totalCents), [totalCents]);
  const change = tendered >= totalCents ? changeDue(totalCents, tendered) : null;
  const splitPaid = parts.reduce((s, p) => s + p.amount, 0);
  const splitRemaining = totalCents - splitPaid;

  async function submit(payments: CheckoutPayment[]) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await onSubmit(payments);
    setBusy(false);
    if (!r.ok) setError(r.error);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !tab.startsWith("mp_")) onClose();
      if (e.key === "Enter" && tab === "cash" && change !== null && !busy) {
        e.preventDefault();
        void submit([cash(totalCents, tendered)]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, change, busy, tendered, totalCents]);

  const tabs: Array<{
    id: Tab;
    label: string;
    icon: React.ReactNode;
    disabled?: boolean;
    hint?: string;
  }> = [
    {
      id: "cash",
      label: "Efectivo",
      icon: <Banknote size={18} />,
      disabled: !registerOpen,
      hint: registerOpen ? undefined : "Requiere caja abierta",
    },
    { id: "card_terminal", label: "Tarjeta", icon: <CreditCard size={18} /> },
    { id: "transfer", label: "Transferencia", icon: <Landmark size={18} /> },
    ...(mpPoint
      ? [{ id: "mp_point" as Tab, label: "MP Point", icon: <Smartphone size={18} /> }]
      : []),
    ...(mpQr ? [{ id: "mp_qr" as Tab, label: "MP QR", icon: <QrCode size={18} /> }] : []),
    { id: "split", label: "Dividido", icon: <SplitSquareHorizontal size={18} /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-title"
    >
      <div
        className="card card-lg flex max-h-[96dvh] w-full max-w-2xl flex-col overflow-hidden rounded-b-none md:rounded-b-[var(--r-card-lg)]"
        data-testid="checkout-modal"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 id="checkout-title" className="text-lg font-semibold">
              Cobrar
            </h2>
            <p
              className="text-2xl font-semibold tabular-nums text-teal-deep"
              data-testid="checkout-total"
            >
              {formatMXN(totalCents)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy || tab.startsWith("mp_")}
            className="btn btn-secondary min-h-11 min-w-11"
            aria-label="Cerrar (Esc)"
          >
            <X size={20} />
          </button>
        </header>

        {zero ? (
          <div className="flex flex-col gap-4 p-5 text-center">
            <p className="text-sm text-muted">
              La recompensa o el cupón cubren el total. No hay nada que cobrar.
            </p>
            {error && (
              <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
                {error}
              </p>
            )}
            <button
              type="button"
              className="btn btn-confirm btn-lg min-h-14"
              disabled={busy}
              onClick={() => void submit([])}
              data-testid="confirm-payment"
            >
              {busy ? "Registrando…" : "Registrar venta"}
            </button>
          </div>
        ) : (
          <>
            <div
              className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2"
              role="tablist"
              aria-label="Método de pago"
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  disabled={t.disabled || busy}
                  title={t.hint}
                  onClick={() => {
                    setTab(t.id);
                    setError(null);
                  }}
                  className={`pill flex min-h-11 shrink-0 items-center gap-1.5 px-3.5 text-sm font-semibold transition disabled:opacity-40 ${tab === t.id ? "bg-teal text-white" : "bg-black/5 hover:bg-black/10"}`}
                  data-testid={`pay-tab-${t.id}`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!registerOpen && (
                <p className="st-amber mb-3 rounded-[var(--r-btn)] px-3 py-2 text-sm">
                  La caja está cerrada: no se puede cobrar en efectivo.{" "}
                  {config.canRegister ? (
                    <Link href="/caja" className="font-semibold underline">
                      Abrir caja
                    </Link>
                  ) : (
                    "Pide a un encargado abrirla."
                  )}
                </p>
              )}

              {tab === "cash" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <div className="card p-3">
                      <div className="text-xs font-medium uppercase tracking-wide text-muted">
                        Recibido
                      </div>
                      <div className="text-3xl font-semibold tabular-nums" data-testid="tendered">
                        {formatMXN(tendered)}
                      </div>
                    </div>
                    <div className={`card p-3 ${change !== null ? "st-green" : ""}`}>
                      <div className="text-xs font-medium uppercase tracking-wide opacity-70">
                        Cambio
                      </div>
                      <div className="text-3xl font-semibold tabular-nums" data-testid="change">
                        {change === null ? "—" : formatMXN(change)}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {quick.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setTendered(q)}
                          className={`btn min-h-12 tabular-nums ${tendered === q ? "btn-primary" : "btn-secondary"}`}
                          data-testid={`quick-${q}`}
                        >
                          {q === totalCents ? "Exacto" : formatMXN(q, { compact: true })}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Numpad
                    valueCents={tendered}
                    onChange={setTendered}
                    onEnter={() => void submit([cash(totalCents, tendered)])}
                    enterDisabled={change === null || busy}
                    enterLabel={busy ? "Cobrando…" : "Cobrar"}
                  />
                </div>
              )}

              {(tab === "card_terminal" || tab === "transfer") && (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit([manual(tab, totalCents, reference)]);
                  }}
                >
                  <label className="label" htmlFor="pay-reference">
                    {tab === "card_terminal"
                      ? "Referencia / autorización de la terminal (opcional)"
                      : "Referencia o clave de rastreo (opcional)"}
                  </label>
                  <input
                    id="pay-reference"
                    className="input min-h-12 text-base"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    maxLength={80}
                    autoFocus
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted">
                    {tab === "card_terminal"
                      ? "Confirma solo cuando la terminal externa haya aprobado el cargo."
                      : "Confirma solo cuando veas la transferencia acreditada."}
                  </p>
                  <button
                    className="btn btn-confirm btn-lg min-h-14"
                    disabled={busy}
                    data-testid="confirm-payment"
                  >
                    {busy
                      ? "Registrando…"
                      : `Confirmar ${PAYMENT_METHOD_LABELS[tab].toLowerCase()} · ${formatMXN(totalCents)}`}
                  </button>
                </form>
              )}

              {tab === "mp_point" && (
                <MpPayment key="point" kind="point" totalCents={totalCents} handlers={mp} />
              )}
              {tab === "mp_qr" && (
                <MpPayment key="qr" kind="qr" totalCents={totalCents} handlers={mp} />
              )}

              {tab === "split" && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-muted">Pendiente por cubrir</span>
                    <span
                      className={`text-2xl font-semibold tabular-nums ${splitRemaining === 0 ? "text-green-d" : ""}`}
                    >
                      {formatMXN(Math.max(splitRemaining, 0))}
                    </span>
                  </div>
                  {parts.length > 0 && (
                    <ul className="divide-y divide-line rounded-[var(--r-card)] border border-line">
                      {parts.map((p, i) => (
                        <li
                          key={i}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <span>
                            {PAYMENT_METHOD_LABELS[p.method]}
                            {p.method === "cash" && p.tendered && p.tendered > p.amount
                              ? ` · recibido ${formatMXN(p.tendered)} (cambio ${formatMXN(p.tendered - p.amount)})`
                              : ""}
                            {p.reference ? ` · ref ${p.reference}` : ""}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="font-semibold tabular-nums">
                              {formatMXN(p.amount)}
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm min-h-9"
                              onClick={() => setParts(parts.filter((_, j) => j !== i))}
                              aria-label="Quitar parte"
                            >
                              <X size={14} />
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {splitRemaining > 0 ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-1.5">
                          {(["cash", "card_terminal", "transfer"] as const).map((m) => (
                            <button
                              key={m}
                              type="button"
                              disabled={m === "cash" && !registerOpen}
                              onClick={() => setPartMethod(m)}
                              className={`btn min-h-11 flex-1 text-sm disabled:opacity-40 ${partMethod === m ? "btn-primary" : "btn-secondary"}`}
                            >
                              {PAYMENT_METHOD_LABELS[m]}
                            </button>
                          ))}
                        </div>
                        <div className="card p-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-muted">
                            {partMethod === "cash" ? "Efectivo recibido" : "Monto"}
                          </div>
                          <div className="text-2xl font-semibold tabular-nums">
                            {formatMXN(partAmount)}
                          </div>
                          {partMethod === "cash" && partAmount > splitRemaining && (
                            <div className="text-xs text-green-d">
                              Cubre el resto · cambio {formatMXN(partAmount - splitRemaining)}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary min-h-11"
                          onClick={() => setPartAmount(splitRemaining)}
                        >
                          Resto exacto ({formatMXN(splitRemaining)})
                        </button>
                        {partMethod !== "cash" && (
                          <input
                            className="input min-h-11"
                            placeholder="Referencia (opcional)"
                            value={partReference}
                            onChange={(e) => setPartReference(e.target.value)}
                            maxLength={80}
                          />
                        )}
                      </div>
                      <Numpad
                        valueCents={partAmount}
                        onChange={setPartAmount}
                        enterLabel="Agregar"
                        enterDisabled={
                          partAmount <= 0 || (partMethod !== "cash" && partAmount > splitRemaining)
                        }
                        onEnter={() => {
                          const applied = Math.min(partAmount, splitRemaining);
                          const part: SplitPart =
                            partMethod === "cash"
                              ? { method: "cash", amount: applied, tendered: partAmount }
                              : {
                                  method: partMethod,
                                  amount: applied,
                                  reference: partReference.trim() || undefined,
                                };
                          setParts([...parts, part]);
                          setPartAmount(0);
                          setPartReference("");
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-confirm btn-lg min-h-14"
                      disabled={busy}
                      data-testid="confirm-payment"
                      onClick={() =>
                        void submit(
                          parts.map((p) =>
                            p.method === "cash"
                              ? cash(p.amount, p.tendered ?? p.amount)
                              : manual(p.method, p.amount, p.reference ?? ""),
                          ),
                        )
                      }
                    >
                      {busy
                        ? "Cobrando…"
                        : `Cobrar ${formatMXN(totalCents)} en ${parts.length} pagos`}
                    </button>
                  )}
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="st-red mt-3 rounded-[var(--r-btn)] px-3 py-2 text-sm"
                  data-testid="checkout-error"
                >
                  {error}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
