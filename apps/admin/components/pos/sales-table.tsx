"use client";
import { useActionState, useState } from "react";
import { ChevronDown, ChevronUp, Printer } from "lucide-react";
import { formatMXN, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@pdp/domain";
import { refundPaymentAction, voidSaleAction, type ActionState } from "@/app/(app)/pos/ventas/actions";
import { Badge } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export type SaleRow = {
  saleId: string;
  orderId: string;
  folio: string;
  soldAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  customerName: string | null;
  staffName: string | null;
  itemsCount: number;
  totalCents: number;
  refundedCents: number;
  paymentStatus: string;
  items: Array<{ name: string; variantLabel: string | null; qty: number; totalCents: number; notes: string | null }>;
  payments: Array<{ id: string; method: string; status: string; amountCents: number; reference: string | null; refundedCents: number }>;
  refunds: Array<{ amountCents: number; reason: string | null; createdAt: string }>;
};

function statusBadge(s: SaleRow) {
  if (s.voidedAt) return <Badge tone="gray">Anulada</Badge>;
  if (s.paymentStatus === "refunded") return <Badge tone="red">Reembolsada</Badge>;
  if (s.paymentStatus === "partially_refunded") return <Badge tone="amber">Reembolso parcial</Badge>;
  return <Badge tone="green">Completada</Badge>;
}

export function SalesTable({ sales, canRefund }: { sales: SaleRow[]; canRefund: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (sales.length === 0) return <p className="card p-6 text-center text-sm text-muted">No hay ventas para mostrar.</p>;
  return (
    <div className="card overflow-hidden">
      <ul className="divide-y divide-line">
        {sales.map((s) => {
          const expanded = open === s.saleId;
          return (
            <li key={s.saleId} data-testid="sale-row">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : s.saleId)}
                aria-expanded={expanded}
                className="grid min-h-14 w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left hover:bg-black/[.03] sm:grid-cols-[110px_1fr_auto_auto]"
              >
                <span className="font-semibold tabular-nums">{s.folio}</span>
                <span className="min-w-0 text-sm text-muted sm:order-none">
                  {fmtDate(s.soldAt, "time")} · {s.customerName ?? "Público general"} · {s.itemsCount} art.
                </span>
                <span className="flex items-center gap-2 justify-self-end sm:justify-self-auto">{statusBadge(s)}</span>
                <span className="flex items-center gap-2 justify-self-end">
                  <span className={`font-semibold tabular-nums ${s.voidedAt ? "line-through text-muted" : ""}`}>{formatMXN(s.totalCents)}</span>
                  {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </span>
              </button>
              {expanded && <SaleDetail s={s} canRefund={canRefund} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SaleDetail({ s, canRefund }: { s: SaleRow; canRefund: boolean }) {
  const [mode, setMode] = useState<"none" | "void" | "refund">("none");
  const refundable = s.payments.filter((p) => (p.status === "paid" || p.status === "partially_refunded") && p.amountCents - p.refundedCents > 0);
  return (
    <div className="border-t border-line bg-bg/60 px-4 py-3">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Artículos</h3>
          <ul className="text-sm">
            {s.items.map((i, idx) => (
              <li key={idx} className="flex justify-between gap-2 py-0.5">
                <span>
                  {i.qty} × {i.name}
                  {i.variantLabel ? ` (${i.variantLabel})` : ""}
                  {i.notes && <span className="block text-xs text-muted">{i.notes}</span>}
                </span>
                <span className="tabular-nums">{formatMXN(i.totalCents)}</span>
              </li>
            ))}
          </ul>
          {s.staffName && <p className="mt-2 text-xs text-muted">Atendió: {s.staffName}</p>}
          {s.voidReason && <p className="mt-1 text-xs text-red-d">Motivo de anulación: {s.voidReason}</p>}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Pagos</h3>
          <ul className="text-sm">
            {s.payments.map((p) => (
              <li key={p.id} className="flex justify-between gap-2 py-0.5">
                <span>
                  {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method}
                  {p.reference ? <span className="text-xs text-muted"> · ref {p.reference}</span> : null}
                  {p.status !== "paid" && <span className="text-xs text-muted"> · {p.status}</span>}
                </span>
                <span className="tabular-nums">{formatMXN(p.amountCents)}</span>
              </li>
            ))}
          </ul>
          {s.refunds.length > 0 && (
            <>
              <h3 className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted">Reembolsos</h3>
              <ul className="text-sm">
                {s.refunds.map((r, idx) => (
                  <li key={idx} className="flex justify-between gap-2 py-0.5">
                    <span>
                      {fmtDate(r.createdAt, "datetime")}
                      {r.reason ? <span className="text-xs text-muted"> · {r.reason}</span> : null}
                    </span>
                    <span className="tabular-nums text-red-d">−{formatMXN(r.amountCents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={`/recibo/${s.orderId}`} target="_blank" rel="noopener" className="btn btn-secondary btn-sm min-h-11">
          <Printer size={15} /> Recibo
        </a>
        {canRefund && !s.voidedAt && (
          <>
            <button type="button" className={`btn btn-sm min-h-11 ${mode === "void" ? "btn-danger" : "btn-secondary"}`} onClick={() => setMode(mode === "void" ? "none" : "void")}>
              Anular venta
            </button>
            {refundable.length > 0 && (
              <button type="button" className={`btn btn-sm min-h-11 ${mode === "refund" ? "btn-undo" : "btn-secondary"}`} onClick={() => setMode(mode === "refund" ? "none" : "refund")}>
                Reembolso parcial
              </button>
            )}
          </>
        )}
      </div>
      {mode === "void" && <VoidForm saleId={s.saleId} onDone={() => setMode("none")} />}
      {mode === "refund" && <RefundForm payments={refundable} onDone={() => setMode("none")} />}
    </div>
  );
}

function VoidForm({ saleId, onDone }: { saleId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(voidSaleAction, {});
  if (state.ok) {
    return (
      <p role="status" className="st-green mt-3 rounded-[var(--r-btn)] px-3 py-2 text-sm">
        {state.message}{" "}
        <button type="button" className="underline" onClick={onDone}>
          Cerrar
        </button>
      </p>
    );
  }
  return (
    <form action={action} className="mt-3 flex flex-col gap-2 rounded-[var(--r-card)] border border-red/40 bg-white p-3">
      <input type="hidden" name="sale_id" value={saleId} />
      <p className="text-sm font-semibold text-red-d">Anular toda la venta</p>
      <p className="text-xs text-muted">Regresa el stock, revierte los puntos y cupones y marca los pagos como cancelados. No se puede deshacer.</p>
      <input name="reason" className="input min-h-11" placeholder="Motivo (obligatorio)" required minLength={3} maxLength={200} />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="confirm" className="h-5 w-5" required /> Confirmo que deseo anular esta venta
      </label>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn btn-danger min-h-11" disabled={pending}>
          {pending ? "Anulando…" : "Anular venta"}
        </button>
        <button type="button" className="btn btn-secondary min-h-11" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

function RefundForm({ payments, onDone }: { payments: SaleRow["payments"]; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(refundPaymentAction, {});
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "");
  const pay = payments.find((p) => p.id === paymentId);
  const max = pay ? pay.amountCents - pay.refundedCents : 0;
  if (state.ok) {
    return (
      <p role="status" className="st-green mt-3 rounded-[var(--r-btn)] px-3 py-2 text-sm">
        {state.message}{" "}
        <button type="button" className="underline" onClick={onDone}>
          Cerrar
        </button>
      </p>
    );
  }
  return (
    <form action={action} className="mt-3 flex flex-col gap-2 rounded-[var(--r-card)] border border-amber/50 bg-white p-3">
      <p className="text-sm font-semibold text-amber-d">Reembolso parcial</p>
      <p className="text-xs text-muted">Solo el dinero: el stock no regresa. Los puntos se revierten en proporción.</p>
      {payments.length > 1 && (
        <select name="payment_id" className="input min-h-11" value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
          {payments.map((p) => (
            <option key={p.id} value={p.id}>
              {PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} · {formatMXN(p.amountCents - p.refundedCents)} disponibles
            </option>
          ))}
        </select>
      )}
      {payments.length === 1 && <input type="hidden" name="payment_id" value={paymentId} />}
      <div className="flex items-center gap-2">
        <label className="text-sm" htmlFor={`refund-amount-${paymentId}`}>
          Monto $
        </label>
        <input id={`refund-amount-${paymentId}`} name="amount" type="number" inputMode="decimal" step="0.01" min="0.01" max={(max / 100).toFixed(2)} className="input min-h-11 w-36" required placeholder={(max / 100).toFixed(2)} />
        <span className="text-xs text-muted">máx. {formatMXN(max)}</span>
      </div>
      <input name="reason" className="input min-h-11" placeholder="Motivo (obligatorio)" required minLength={3} maxLength={200} />
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" name="confirm" className="h-5 w-5" required /> Confirmo el reembolso
      </label>
      {state.error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-sm">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <button className="btn btn-undo min-h-11" disabled={pending || !pay}>
          {pending ? "Registrando…" : "Registrar reembolso"}
        </button>
        <button type="button" className="btn btn-secondary min-h-11" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
