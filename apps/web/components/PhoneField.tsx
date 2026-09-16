"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  parsePhone,
  phoneCountryOrDefault,
  phoneExample,
  PHONE_COUNTRIES,
  type PhoneCountry,
} from "@pdp/domain";

export type PhoneFieldChange = { country: string; national: string };

// Detecta "ya hay JavaScript vivo" sin efectos: en el servidor devuelve false y en el navegador true.
const noopSubscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

type Props = {
  /** Nombre del campo del número. El país viaja en `<name>_country`. */
  name?: string;
  label: string;
  required?: boolean;
  /** País (ISO) con el que abre el campo. Por defecto México. */
  defaultCountry?: string | null;
  /** Número nacional con el que abre el campo (al repoblar tras un error del servidor). */
  defaultValue?: string | null;
  error?: string | null;
  /** Texto de ayuda propio; si no se pasa, se muestra el ejemplo del país elegido. */
  help?: string | null;
  testId?: string;
  onChange?: (v: PhoneFieldChange) => void;
};

/**
 * Campo de teléfono con selector de país (bandera + prefijo) y número nacional.
 *
 * - Manda al servidor DOS campos —`<name>_country` y `<name>`— y es el servidor el que los combina
 *   en el valor canónico (`parsePhone` en `@pdp/domain`). El navegador no decide nada.
 * - Funciona sin JavaScript: mientras no hidrata, el selector es un `<select>` nativo que el
 *   formulario envía igual. Al hidratar se sustituye por la lista con banderas.
 * - Sin dependencias nuevas: las banderas son emoji y la lista de países vive en `@pdp/domain`.
 */
export function PhoneField({
  name = "phone",
  label,
  required,
  defaultCountry,
  defaultValue,
  error,
  help,
  testId,
  onChange,
}: Props) {
  const uid = useId();
  const inputId = `${uid}-phone`;
  const helpId = `${uid}-phone-help`;
  const [country, setCountry] = useState<PhoneCountry>(() => phoneCountryOrDefault(defaultCountry));
  const [national, setNational] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  // Progresivo: el `<select>` nativo es lo que se sirve en HTML (y lo que funciona sin JS);
  // la lista con banderas aparece solo cuando React ya está vivo.
  const enhanced = useSyncExternalStore(noopSubscribe, onClient, onServer);

  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const emit = (c: PhoneCountry, n: string) => onChange?.({ country: c.iso, national: n });

  const pick = (c: PhoneCountry) => {
    setCountry(c);
    setOpen(false);
    emit(c, national);
    trigger.current?.focus();
  };

  /** Si pegan el número completo en internacional, el selector se mueve solo al país que toca. */
  const typed = (raw: string) => {
    if (/^\s*(\+|00)/.test(raw)) {
      const r = parsePhone(country.iso, raw);
      if (r.ok) {
        setCountry(r.country);
        setNational(r.national);
        emit(r.country, r.national);
        return;
      }
    }
    setNational(raw);
    emit(country, raw);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, PHONE_COUNTRIES.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(PHONE_COUNTRIES.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const c = PHONE_COUNTRIES[active];
      if (c) pick(c);
    }
  };

  return (
    <div>
      <label htmlFor={inputId} className="label">
        {label}
      </label>
      <div className="relative" ref={wrap}>
        <div className="flex gap-2">
          {enhanced ? (
            <>
              <input type="hidden" name={`${name}_country`} value={country.iso} />
              <button
                type="button"
                ref={trigger}
                onClick={() => {
                  setActive(PHONE_COUNTRIES.findIndex((c) => c.iso === country.iso));
                  setOpen((o) => !o);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive(PHONE_COUNTRIES.findIndex((c) => c.iso === country.iso));
                    setOpen(true);
                  }
                }}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={`País del teléfono: ${country.name}, prefijo +${country.dial}`}
                data-testid={testId ? `${testId}-country` : undefined}
                className="input flex w-auto shrink-0 items-center gap-1.5 px-3 tabular-nums"
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {country.flag}
                </span>
                <span>+{country.dial}</span>
                <span aria-hidden="true" className="text-[10px] text-ink-2">
                  ▼
                </span>
              </button>
            </>
          ) : (
            <select
              name={`${name}_country`}
              defaultValue={country.iso}
              onChange={(e) => {
                const c = phoneCountryOrDefault(e.target.value);
                setCountry(c);
                emit(c, national);
              }}
              aria-label="País del teléfono"
              className="input w-auto shrink-0 px-3"
            >
              {PHONE_COUNTRIES.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {c.flag} {c.name} (+{c.dial})
                </option>
              ))}
            </select>
          )}
          <input
            id={inputId}
            name={name}
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            className="input"
            required={required}
            maxLength={24}
            value={national}
            onChange={(e) => typed(e.target.value)}
            placeholder={country.example}
            aria-describedby={helpId}
            aria-invalid={Boolean(error)}
            data-testid={testId}
          />
        </div>
        {enhanced && open && (
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-label="Elige el país del teléfono"
            onKeyDown={onListKey}
            data-testid={testId ? `${testId}-list` : undefined}
            className="absolute top-[calc(100%+6px)] left-0 z-30 max-h-64 w-full max-w-sm overflow-y-auto rounded-card border border-line bg-paper py-1 shadow-lift focus:outline-none"
          >
            {PHONE_COUNTRIES.map((c, i) => (
              <li key={c.iso}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.iso === country.iso}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c)}
                  className={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm text-ink ${
                    i === active ? "bg-sage/10" : ""
                  } ${c.iso === country.iso ? "font-semibold" : ""}`}
                >
                  <span aria-hidden="true" className="text-lg leading-none">
                    {c.flag}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-2">+{c.dial}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p id={helpId} className="help">
        {help ? `${help} ${phoneExample(country)}.` : `${phoneExample(country)}.`}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
