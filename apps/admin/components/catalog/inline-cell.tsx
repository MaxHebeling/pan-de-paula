"use client";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toCents } from "@pdp/domain";
import type { ActionState } from "@/lib/action-state";

/**
 * Celda editable "como hoja de cálculo": clic / Enter / F2 abre el editor; Enter guarda; Esc cancela;
 * Tab guarda y pasa a la siguiente celda; salir del campo (blur) guarda si cambió.
 * El servidor recalcula siempre: `onSave` es una server action y devuelve el estado.
 */

export type CellKind = "money" | "number" | "integer" | "percent" | "text";
export type CellValue = number | string | null;

export type InlineCellProps = {
  kind: CellKind;
  value: CellValue;
  /** Texto en modo lectura. */
  display: ReactNode;
  /** Nombre accesible ("Rendimiento de Croissant"). */
  label: string;
  onSave: (value: CellValue) => Promise<ActionState>;
  /** Se llama con cada tecla (valor parseado) para recalcular en vivo; `undefined` al terminar de editar. */
  onDraft?: (value: CellValue | undefined) => void;
  disabled?: boolean;
  /** Vacío → null (quita un override). */
  nullable?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  className?: string;
  align?: "left" | "right";
  inputClassName?: string;
  testId?: string;
  /** Nota corta bajo el editor ("vacío = default 60%"). */
  hint?: string;
};

function toInput(kind: CellKind, value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (kind === "money") return (Number(value) / 100).toFixed(2);
  if (kind === "percent") return String(Number(value) / 100);
  return String(value);
}

function parse(
  kind: CellKind,
  raw: string,
  nullable: boolean,
): { ok: true; value: CellValue } | { ok: false; error: string } {
  const t = raw.trim();
  if (t === "")
    return nullable ? { ok: true, value: null } : { ok: false, error: "Escribe un valor" };
  if (kind === "text") return { ok: true, value: t };
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n)) return { ok: false, error: "Número inválido" };
  if (kind === "money") return { ok: true, value: toCents(n) };
  if (kind === "percent") return { ok: true, value: Math.round(n * 100) };
  if (kind === "integer") return { ok: true, value: Math.round(n) };
  return { ok: true, value: n };
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b;
  return typeof a === "string" || typeof b === "string"
    ? String(a) === String(b)
    : Math.abs(a - b) < 1e-9;
}

/** Enfoca (y abre) la celda editable anterior/siguiente en orden del documento. */
export function focusSiblingCell(from: HTMLElement | null, dir: 1 | -1) {
  if (!from) return;
  const wrap = from.closest<HTMLElement>("[data-inline-cell]");
  const cells = Array.from(
    document.querySelectorAll<HTMLElement>("[data-inline-cell]:not([data-disabled='true'])"),
  );
  const i = wrap ? cells.indexOf(wrap) : -1;
  const next = cells[i + dir];
  const btn = next?.querySelector<HTMLElement>("button,[role=switch]");
  if (btn) {
    btn.focus();
    btn.click();
  }
}

export function InlineCell({
  kind,
  value,
  display,
  label,
  onSave,
  onDraft,
  disabled = false,
  nullable = false,
  min,
  max,
  step,
  placeholder,
  className = "",
  align = "right",
  inputClassName = "",
  testId,
  hint,
}: InlineCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<"ok" | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const closingRef = useRef(false);
  const errId = useId();

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  function open() {
    if (disabled) return;
    setDraft(toInput(kind, value));
    setError(null);
    closingRef.current = false;
    setEditing(true);
  }
  function close() {
    closingRef.current = true;
    setEditing(false);
    setError(null);
    onDraft?.(undefined);
  }
  function commit(after?: () => void) {
    // Enter/Tab repetidos mientras el servidor responde no deben disparar una segunda acción
    // (en precios crearía dos filas de historial; en parámetros subiría la versión dos veces).
    if (pending || closingRef.current) return;
    const parsed = parse(kind, draft, nullable);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (sameValue(parsed.value, value)) {
      close();
      after?.();
      return;
    }
    if (typeof parsed.value === "number") {
      if (min !== undefined && parsed.value < (kind === "percent" ? min * 100 : min))
        return setError(`Mínimo ${min}`);
      if (max !== undefined && parsed.value > (kind === "percent" ? max * 100 : max))
        return setError(`Máximo ${max}`);
    }
    closingRef.current = true;
    startTransition(async () => {
      const r = await onSave(parsed.value);
      if (r.error) {
        closingRef.current = false;
        setError(r.error);
        return;
      }
      setEditing(false);
      setFlash("ok");
      onDraft?.(undefined);
      after?.();
    });
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      const from = wrapRef.current;
      commit(() => focusSiblingCell(from, dir));
    }
  }
  function onChange(raw: string) {
    setDraft(raw);
    setError(null);
    if (onDraft) {
      const p = parse(kind, raw, nullable);
      onDraft(p.ok ? p.value : undefined);
    }
  }

  const alignCls = align === "right" ? "text-right" : "text-left";

  return (
    <span
      ref={wrapRef}
      data-inline-cell
      data-disabled={disabled ? "true" : undefined}
      className={`relative block ${className}`}
    >
      {editing ? (
        <span className="block">
          <input
            ref={inputRef}
            type="text"
            inputMode={kind === "text" ? "text" : "decimal"}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
            className={`input min-h-11 w-full !py-1.5 ${alignCls} ${inputClassName}`}
            value={draft}
            placeholder={placeholder}
            min={min}
            max={max}
            step={step}
            disabled={pending}
            aria-busy={pending}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => {
              if (closingRef.current || pending) return;
              // Al salir del campo se guarda si cambió (comportamiento de hoja de cálculo).
              const p = parse(kind, draft, nullable);
              if (p.ok && sameValue(p.value, value)) close();
              else commit();
            }}
            data-testid={testId ? `${testId}-input` : undefined}
          />
          {hint && !error && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
          {error && (
            <span id={errId} role="alert" className="mt-0.5 block text-[11px] text-red-d">
              {error}
            </span>
          )}
        </span>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === "F2" || e.key === "Enter") {
              e.preventDefault();
              open();
            }
          }}
          aria-label={`${label}. Editar`}
          title={disabled ? undefined : "Clic o Enter para editar"}
          className={`inline-cell ${alignCls} ${flash ? "inline-cell-ok" : ""} ${disabled ? "inline-cell-ro" : ""}`}
          data-testid={testId}
        >
          {display}
        </button>
      )}
    </span>
  );
}

/** Interruptor inline (activo / visible / destacado…). */
export function InlineToggle({
  checked,
  label,
  onToggle,
  disabled,
  onLabel = "Sí",
  offLabel = "No",
  testId,
}: {
  checked: boolean;
  label: string;
  onToggle: (next: boolean) => Promise<ActionState>;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
  testId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimista solo mientras la prop no cambie: cuando el servidor confirma (prop nueva) se ignora sola.
  const [optimistic, setOptimistic] = useState<{ base: boolean; value: boolean } | null>(null);
  const shown = optimistic && optimistic.base === checked ? optimistic.value : checked;
  return (
    <span data-inline-cell data-disabled={disabled ? "true" : undefined} className="inline-block">
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={label}
        aria-busy={pending}
        disabled={disabled || pending}
        data-testid={testId}
        onClick={() => {
          const next = !shown;
          setOptimistic({ base: checked, value: next });
          setError(null);
          startTransition(async () => {
            const r = await onToggle(next);
            if (r.error) {
              setOptimistic(null);
              setError(r.error);
            }
          });
        }}
        className={`pill inline-flex min-h-11 min-w-16 items-center justify-center px-3 text-xs font-semibold transition-colors ${
          shown ? "st-green" : "st-gray"
        } ${disabled ? "opacity-60" : "hover:brightness-95"}`}
      >
        {shown ? onLabel : offLabel}
      </button>
      {error && (
        <span role="alert" className="block text-[11px] text-red-d">
          {error}
        </span>
      )}
    </span>
  );
}
