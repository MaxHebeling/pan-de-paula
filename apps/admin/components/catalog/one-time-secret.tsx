"use client";
import { useState } from "react";

/** Muestra un secreto de una sola vez (contraseña temporal, enlace) con botón de copiar. */
export function OneTimeSecret({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="st-amber mt-3 rounded-[var(--r-card)] px-4 py-3 text-sm" role="status">
      <div className="text-xs font-semibold uppercase tracking-wide">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <code className="select-all break-all rounded bg-white/70 px-2 py-1 font-mono text-base">
          {value}
        </code>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch (e) {
              console.error("No se pudo copiar al portapapeles", e);
            }
          }}
        >
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      {hint && <p className="mt-1 text-xs opacity-80">{hint}</p>}
    </div>
  );
}
