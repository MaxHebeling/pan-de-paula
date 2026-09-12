"use client";
import { useState } from "react";
import { AlertTriangle, Cloud, CloudOff, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { formatMXN } from "@pdp/domain";
import type { QueuedSale, SyncStatus } from "./offline-queue";

const LABEL: Record<SyncStatus, string> = {
  synced: "SINCRONIZADO",
  saving: "GUARDANDO",
  offline: "OFFLINE",
  error: "ERROR",
};

export function SyncIndicator({
  status,
  count,
  items,
  online,
  onRetry,
  onDiscard,
  onSyncNow,
}: {
  status: SyncStatus;
  count: number;
  items: QueuedSale[];
  online: boolean;
  onRetry: (key: string) => void;
  onDiscard: (key: string) => void;
  onSyncNow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = status === "synced" ? "st-green" : status === "saving" ? "st-blue" : status === "offline" ? "st-amber" : "st-red";
  const Icon = status === "synced" ? Cloud : status === "saving" ? Loader2 : status === "offline" ? CloudOff : AlertTriangle;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${tone} pill flex min-h-9 items-center gap-1.5 px-3 text-xs font-semibold`}
        aria-label={`Estado de sincronización: ${LABEL[status]}${count ? ` (${count})` : ""}`}
        data-testid="sync-indicator"
      >
        <Icon size={14} className={status === "saving" ? "animate-spin" : ""} aria-hidden />
        {LABEL[status]}
        {status !== "synced" && count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" role="dialog" aria-modal="true" aria-label="Ventas pendientes de sincronizar">
          <div className="card card-lg w-full max-w-lg p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Cola offline · {online ? "con conexión" : "sin conexión"}</h2>
              <button type="button" className="btn btn-secondary btn-sm min-h-11 min-w-11" onClick={() => setOpen(false)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-muted">No hay ventas pendientes. Todo está sincronizado.</p>
            ) : (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto">
                {items.map((i) => {
                  const failed = i.lastStatus !== null && i.lastStatus >= 400 && i.lastStatus < 500;
                  return (
                    <li key={i.key} className="flex items-start justify-between gap-2 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="font-semibold tabular-nums">
                          {formatMXN(i.summary.totalCents)} · {i.summary.itemsCount} art.
                          {i.summary.customerName ? ` · ${i.summary.customerName}` : ""}
                        </div>
                        <div className="text-xs text-muted">{new Date(i.createdAt).toLocaleString("es-MX")}</div>
                        {i.lastError && <div className={`text-xs ${failed ? "text-red-d" : "text-amber-d"}`}>{i.lastError}</div>}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {failed && (
                          <button type="button" className="btn btn-secondary btn-sm min-h-9" onClick={() => onRetry(i.key)} aria-label="Reintentar">
                            <RefreshCw size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-danger btn-sm min-h-9"
                          onClick={() => {
                            if (window.confirm("¿Descartar esta venta pendiente? No se registrará en el sistema.")) onDiscard(i.key);
                          }}
                          aria-label="Descartar"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {items.length > 0 && (
              <button type="button" className="btn btn-primary mt-3 min-h-11 w-full" onClick={onSyncNow} disabled={!online}>
                <RefreshCw size={16} /> Sincronizar ahora
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
