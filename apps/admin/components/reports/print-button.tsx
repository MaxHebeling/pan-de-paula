"use client";
import { Printer } from "lucide-react";

/** Imprimir / guardar como PDF la vista actual (usa los estilos @media print de print.css). */
export function PrintButton({ label = "Imprimir / PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-secondary no-print" onClick={() => window.print()}>
      <Printer size={16} aria-hidden />
      {label}
    </button>
  );
}
