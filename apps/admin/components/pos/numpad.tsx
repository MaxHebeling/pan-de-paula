"use client";
import { Delete } from "lucide-react";

/**
 * Teclado numérico táctil estilo caja: los dígitos entran por la derecha en centavos
 * (1,2,3,4,5 → $123.45). Botones ≥ 56px.
 */
export function Numpad({
  valueCents,
  onChange,
  onEnter,
  enterLabel = "Aceptar",
  enterDisabled,
  className = "",
}: {
  valueCents: number;
  onChange: (cents: number) => void;
  onEnter?: () => void;
  enterLabel?: string;
  enterDisabled?: boolean;
  className?: string;
}) {
  const push = (d: string) => {
    const next = Number(String(valueCents) + d);
    if (Number.isSafeInteger(next) && next < 100_000_000) onChange(next);
  };
  const back = () => onChange(Math.floor(valueCents / 10));
  const keys: Array<{ k: string; label: string; act: () => void; cls?: string }> = [
    ..."123456789".split("").map((d) => ({ k: d, label: d, act: () => push(d) })),
    { k: "C", label: "C", act: () => onChange(0), cls: "btn-undo" },
    { k: "0", label: "0", act: () => push("0") },
    { k: "00", label: "00", act: () => push("00") },
  ];
  return (
    <div
      className={`grid grid-cols-3 gap-2 ${className}`}
      role="group"
      aria-label="Teclado numérico"
    >
      {keys.map((b) => (
        <button
          key={b.k}
          type="button"
          onClick={b.act}
          className={`btn ${b.cls ?? "btn-secondary"} min-h-14 text-xl font-semibold tabular-nums`}
          aria-label={b.k === "C" ? "Borrar todo" : b.label}
        >
          {b.label}
        </button>
      ))}
      <button
        type="button"
        onClick={back}
        className="btn btn-secondary col-span-1 min-h-14"
        aria-label="Borrar último dígito"
      >
        <Delete size={22} />
      </button>
      {onEnter && (
        <button
          type="button"
          onClick={onEnter}
          disabled={enterDisabled}
          className="btn btn-confirm col-span-2 min-h-14 text-lg"
        >
          {enterLabel}
        </button>
      )}
    </div>
  );
}
