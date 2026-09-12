"use client";
import { Printer } from "lucide-react";

/** Imprime la vista actual. Los estilos `@media print` de cada página ocultan la navegación. */
export function PrintButton({ label = "Imprimir" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-secondary no-print" onClick={() => window.print()}>
      <Printer size={16} aria-hidden /> {label}
    </button>
  );
}
