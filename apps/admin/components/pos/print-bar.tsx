"use client";
import { useEffect } from "react";
import { Printer, X } from "lucide-react";

/** Barra de acciones de las vistas imprimibles (recibo / corte). Con ?print=1 lanza el diálogo de impresión. */
export function PrintBar({ autoPrint, backHref }: { autoPrint: boolean; backHref: string }) {
  useEffect(() => {
    if (!autoPrint) return;
    const t = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(t);
  }, [autoPrint]);
  return (
    <div className="no-print mx-auto mb-3 flex w-full max-w-sm items-center justify-between gap-2">
      <a href={backHref} className="btn btn-secondary min-h-11">
        <X size={16} /> Cerrar
      </a>
      <button type="button" onClick={() => window.print()} className="btn btn-primary min-h-11">
        <Printer size={16} /> Imprimir
      </button>
    </div>
  );
}
