"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { formatMXN } from "@pdp/domain";
import { NetworkError, type ApiResult } from "./api";
import type { MpStartResult, PaymentStatusResult } from "./types";

const POLL_MS = 2500;
const SLOW_AFTER_MS = 90_000;

export type MpHandlers = {
  start: (kind: "point" | "qr") => Promise<ApiResult<MpStartResult>>;
  status: (orderId: string) => Promise<ApiResult<PaymentStatusResult>>;
  cancel: (orderId: string) => Promise<ApiResult<{ cancelled: boolean; saleId: string | null }>>;
  onConfirmed: (s: PaymentStatusResult) => void;
  onAbandoned: () => void;
};

type Phase =
  | { k: "idle" }
  | { k: "starting" }
  | { k: "waiting"; order: MpStartResult; qrUrl?: string; slow: boolean; pollError: string | null }
  | { k: "failed"; order: MpStartResult | null; message: string }
  | { k: "cancelling"; order: MpStartResult };

/**
 * Cobro con Mercado Pago Point (terminal) o QR dinámico. El POS NUNCA marca pagado por su cuenta:
 * consulta /api/pos/payments/status hasta que el webhook confirme (outcome=confirmed) o falle.
 */
export function MpPayment({
  kind,
  totalCents,
  handlers,
}: {
  kind: "point" | "qr";
  totalCents: number;
  handlers: MpHandlers;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const alive = useRef(true);
  const startedAt = useRef<number>(0);
  const label = kind === "point" ? "terminal Point" : "QR de Mercado Pago";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const begin = useCallback(async () => {
    setPhase({ k: "starting" });
    try {
      const r = await handlers.start(kind);
      if (!alive.current) return;
      if (!r.ok) {
        setPhase({ k: "failed", order: null, message: r.error });
        return;
      }
      const alreadyPaid = (r.data as MpStartResult & { alreadyPaid?: boolean }).alreadyPaid;
      let qrUrl: string | undefined;
      if (kind === "qr" && r.data.qrData) {
        try {
          qrUrl = await QRCode.toDataURL(r.data.qrData, { width: 320, margin: 1 });
        } catch (e) {
          console.error("[pos] no se pudo dibujar el QR", (e as Error).message);
        }
      }
      startedAt.current = Date.now();
      setPhase({ k: "waiting", order: r.data, qrUrl, slow: false, pollError: null });
      if (alreadyPaid) {
        const s = await handlers.status(r.data.orderId);
        if (s.ok && s.data.outcome === "confirmed") handlers.onConfirmed(s.data);
      }
    } catch (e) {
      if (!alive.current) return;
      setPhase({
        k: "failed",
        order: null,
        message:
          e instanceof NetworkError
            ? "Sin conexión. Mercado Pago requiere internet; cobra en efectivo o reintenta."
            : (e as Error).message,
      });
    }
  }, [handlers, kind]);

  useEffect(() => {
    void begin();
    // solo al montar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling mientras esperamos confirmación
  useEffect(() => {
    if (phase.k !== "waiting") return;
    const order = phase.order;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const s = await handlers.status(order.orderId);
        if (stopped) return;
        if (!s.ok) {
          setPhase((p) => (p.k === "waiting" ? { ...p, pollError: s.error } : p));
          return;
        }
        if (s.data.outcome === "confirmed") {
          stopped = true;
          handlers.onConfirmed(s.data);
          return;
        }
        if (s.data.outcome === "failed") {
          stopped = true;
          setPhase({
            k: "failed",
            order,
            message:
              "Mercado Pago rechazó o canceló el cobro. Puedes reintentar o cobrar con otro método.",
          });
          return;
        }
        setPhase((p) =>
          p.k === "waiting"
            ? { ...p, pollError: null, slow: Date.now() - startedAt.current > SLOW_AFTER_MS }
            : p,
        );
      } catch (e) {
        if (stopped) return;
        setPhase((p) =>
          p.k === "waiting"
            ? {
                ...p,
                pollError:
                  e instanceof NetworkError
                    ? "Sin conexión: esperando para volver a consultar…"
                    : (e as Error).message,
              }
            : p,
        );
      }
    };
    const t = window.setInterval(tick, POLL_MS);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [phase.k, phase.k === "waiting" ? phase.order.orderId : null, handlers]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cancel(order: MpStartResult | null) {
    if (!order) {
      handlers.onAbandoned();
      return;
    }
    setPhase({ k: "cancelling", order });
    try {
      const r = await handlers.cancel(order.orderId);
      if (r.ok && !r.data.cancelled && r.data.saleId) {
        // El webhook confirmó justo antes de cancelar: es una venta real.
        const s = await handlers.status(order.orderId);
        if (s.ok && s.data.outcome === "confirmed") {
          handlers.onConfirmed(s.data);
          return;
        }
      }
      if (!r.ok) {
        setPhase({
          k: "failed",
          order,
          message: `No se pudo cancelar: ${r.error}. Verifica en Ventas antes de cobrar de nuevo.`,
        });
        return;
      }
      handlers.onAbandoned();
    } catch (e) {
      setPhase({
        k: "failed",
        order,
        message:
          e instanceof NetworkError
            ? "Sin conexión para cancelar. Verifica en Ventas antes de cobrar de nuevo."
            : (e as Error).message,
      });
    }
  }

  if (phase.k === "idle" || phase.k === "starting") {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Loader2 className="animate-spin text-teal" size={36} aria-hidden />
        <p className="font-medium">
          Enviando {formatMXN(totalCents)} a la {label}…
        </p>
      </div>
    );
  }
  if (phase.k === "cancelling") {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Loader2 className="animate-spin text-muted" size={36} aria-hidden />
        <p className="font-medium">Cancelando cobro…</p>
      </div>
    );
  }
  if (phase.k === "failed") {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <XCircle className="text-red" size={40} aria-hidden />
        <p role="alert" className="max-w-sm text-sm">
          {phase.message}
        </p>
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary min-h-11" onClick={() => void begin()}>
            <RefreshCw size={16} /> Reintentar
          </button>
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            onClick={() => void cancel(phase.order)}
          >
            Otro método
          </button>
        </div>
      </div>
    );
  }
  // waiting
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center" data-testid="mp-waiting">
      {kind === "qr" && phase.qrUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={phase.qrUrl}
          alt="QR para pagar con Mercado Pago"
          className="h-64 w-64 rounded-[var(--r-card)] border border-line bg-white p-2"
        />
      ) : (
        <Loader2 className="animate-spin text-teal" size={40} aria-hidden />
      )}
      <div>
        <p className="text-lg font-semibold tabular-nums">{formatMXN(totalCents)}</p>
        <p className="text-sm text-muted">
          {kind === "point"
            ? "Pide al cliente pagar en la terminal."
            : "El cliente escanea el QR desde su app de Mercado Pago."}
        </p>
        <p className="mt-1 text-xs text-muted">
          Pedido {phase.order.folio} · esperando confirmación de Mercado Pago…
        </p>
      </div>
      {phase.slow && (
        <p className="st-amber rounded-[var(--r-btn)] px-3 py-2 text-xs">
          Está tardando más de lo normal. Si el cliente ya pagó, espera la confirmación (no cobres
          dos veces). Si no, cancela y usa otro método.
        </p>
      )}
      {phase.pollError && (
        <p className="st-amber rounded-[var(--r-btn)] px-3 py-2 text-xs">{phase.pollError}</p>
      )}
      <button
        type="button"
        className="btn btn-secondary min-h-11"
        onClick={() => void cancel(phase.order)}
      >
        Cancelar cobro
      </button>
    </div>
  );
}
