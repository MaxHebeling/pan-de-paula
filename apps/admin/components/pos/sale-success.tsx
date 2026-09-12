"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, CloudOff, Mail, MessageCircle, Printer, Sparkles } from "lucide-react";
import { formatMXN, PAYMENT_METHOD_LABELS } from "@pdp/domain";
import { NetworkError, postJson } from "./api";
import type { CheckoutPayment, CheckoutResult, PosConfig, PosCustomer } from "./types";

export type SaleOutcome =
  | { kind: "online"; result: CheckoutResult; payments: CheckoutPayment[]; changeCents: number }
  | { kind: "queued"; key: string; totalCents: number; changeCents: number; itemsCount: number };

export function SaleSuccess({
  sale,
  config,
  customer,
  onNew,
}: {
  sale: SaleOutcome;
  config: PosConfig;
  customer: PosCustomer | null;
  onNew: () => void;
}) {
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [email, setEmail] = useState(customer?.email ?? "");
  const [msg, setMsg] = useState<{ tone: "green" | "red" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState<"wa" | "email" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNew]);

  const orderId = sale.kind === "online" ? sale.result.orderId : null;

  async function print() {
    if (!orderId) return;
    window.open(`/recibo/${orderId}?print=1`, "_blank", "noopener,width=420,height=720");
    try {
      await postJson("/api/pos/receipt", { orderId, channel: "print" });
    } catch (e) {
      console.error("[pos] no se registró la impresión", (e as Error).message);
    }
  }
  async function whatsapp() {
    if (!orderId) return;
    setBusy("wa");
    setMsg(null);
    try {
      const r = await postJson<{ ok: boolean; url: string }>("/api/pos/receipt", {
        orderId,
        channel: "whatsapp",
        destination: phone,
      });
      if (!r.ok) {
        setMsg({ tone: "red", text: r.error });
        return;
      }
      window.open(r.data.url, "_blank", "noopener");
    } catch (e) {
      setMsg({
        tone: "red",
        text: e instanceof NetworkError ? "Sin conexión" : (e as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }
  async function sendEmail() {
    if (!orderId) return;
    setBusy("email");
    setMsg(null);
    try {
      const r = await postJson<{ ok: boolean }>("/api/pos/receipt", {
        orderId,
        channel: "email",
        destination: email,
      });
      if (!r.ok) {
        setMsg({ tone: r.status === 503 || r.status === 409 ? "amber" : "red", text: r.error });
        return;
      }
      setMsg({ tone: "green", text: `Comprobante enviado a ${email}` });
    } catch (e) {
      setMsg({
        tone: "red",
        text: e instanceof NetworkError ? "Sin conexión" : (e as Error).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const emailEnabled = config.flags.email_receipts;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sale-ok-title"
    >
      <div
        className="card card-lg w-full max-w-lg overflow-y-auto p-5 md:p-6"
        data-testid="sale-success"
      >
        <div className="flex flex-col items-center text-center">
          {sale.kind === "online" ? (
            <CheckCircle2 size={56} className="text-green" aria-hidden />
          ) : (
            <CloudOff size={56} className="text-amber" aria-hidden />
          )}
          <h2 id="sale-ok-title" className="mt-2 text-xl font-semibold">
            {sale.kind === "online"
              ? sale.result.duplicate
                ? "Venta ya registrada"
                : "Venta registrada"
              : "Venta guardada sin conexión"}
          </h2>
          {sale.kind === "online" ? (
            <p className="text-sm text-muted">
              Folio{" "}
              <strong className="text-ink" data-testid="sale-folio">
                {sale.result.folio}
              </strong>{" "}
              · {formatMXN(sale.result.totalCents)}
            </p>
          ) : (
            <p className="max-w-sm text-sm text-muted">
              {formatMXN(sale.totalCents)} en efectivo. Se enviará automáticamente al volver la
              conexión; el folio y los puntos se asignan al sincronizar.
            </p>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className={`card p-3 text-center ${sale.changeCents > 0 ? "st-green" : ""}`}>
            <div className="text-xs font-medium uppercase tracking-wide opacity-70">Cambio</div>
            <div className="text-3xl font-semibold tabular-nums" data-testid="sale-change">
              {formatMXN(sale.changeCents)}
            </div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              {sale.kind === "online" && customer ? "Puntos" : "Pago"}
            </div>
            {sale.kind === "online" && customer ? (
              <div className="text-3xl font-semibold tabular-nums">
                <Sparkles size={18} className="mr-1 inline text-amber" />+{sale.result.pointsEarned}
                {sale.result.pointsBalance !== null && (
                  <span className="block text-xs font-normal text-muted">
                    saldo {sale.result.pointsBalance}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm font-medium">
                {sale.kind === "online"
                  ? sale.payments.length === 0
                    ? "Sin pago (recompensa)"
                    : sale.payments.map((p) => PAYMENT_METHOD_LABELS[p.method]).join(" + ")
                  : "Efectivo"}
              </div>
            )}
          </div>
        </div>

        {sale.kind === "online" && (
          <div className="mt-4 flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => void print()}
                className="btn btn-secondary min-h-12"
              >
                <Printer size={18} /> Imprimir
              </button>
              <div className="flex gap-1 sm:col-span-2">
                <input
                  className="input min-h-12"
                  placeholder="WhatsApp (10 dígitos)"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  aria-label="Teléfono para WhatsApp"
                />
                <button
                  type="button"
                  onClick={() => void whatsapp()}
                  disabled={busy !== null || phone.replace(/\D/g, "").length < 10}
                  className="btn btn-wa min-h-12 shrink-0"
                >
                  <MessageCircle size={18} /> Enviar
                </button>
              </div>
            </div>
            {emailEnabled && (
              <div className="flex gap-1">
                <input
                  className="input min-h-12"
                  placeholder="Email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Email para el comprobante"
                />
                <button
                  type="button"
                  onClick={() => void sendEmail()}
                  disabled={busy !== null || !email.includes("@")}
                  className="btn btn-secondary min-h-12 shrink-0"
                >
                  <Mail size={18} /> {busy === "email" ? "Enviando…" : "Email"}
                </button>
              </div>
            )}
            {msg && (
              <p
                role="status"
                className={`st-${msg.tone} rounded-[var(--r-btn)] px-3 py-2 text-sm`}
              >
                {msg.text}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onNew}
          className="btn btn-primary btn-lg mt-4 min-h-14 w-full"
          data-testid="new-sale"
          autoFocus
        >
          Nueva venta <span className="ml-1 text-xs font-normal opacity-80">Enter</span>
        </button>
      </div>
    </div>
  );
}
