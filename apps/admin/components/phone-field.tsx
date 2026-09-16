"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  parsePhone,
  phoneCountryOrDefault,
  phoneExample,
  PHONE_COUNTRIES,
  splitStoredPhone,
  type PhoneCountry,
} from "@pdp/domain";

export type PhoneFieldChange = { country: string; national: string };

// Detecta "ya hay JavaScript vivo" sin efectos: en el servidor devuelve false y en el navegador true.
const noopSubscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * En el CRM `.input` es CSS sin capa (`width: 100%`) y gana a las utilidades de Tailwind (`w-auto`,
 * `flex-1`), así que los anchos de la fila se fijan en línea: el selector a su tamaño y el número
 * ocupa el resto. Sin esto el botón se comía la fila y el número quedaba fuera de la pantalla.
 */
const FIXED = { width: "auto", flex: "none" } as const;
const NATIVE_SELECT = { width: "8rem", flex: "none" } as const;
const GROW = { width: "auto", minWidth: 0, flex: "1 1 0%" } as const;

/** Sin JavaScript la ayuda no puede seguir al país elegido: se da la instrucción general. */
const NO_JS_HINT = "Escribe tu número sin el prefijo del país.";

type Props = {
  /** Nombre del campo del número. El país viaja en `<name>_country`. */
  name?: string;
  label?: string;
  required?: boolean;
  /** Teléfono ya guardado (canónico): se reparte solo en país + número nacional. */
  storedValue?: string | null;
  /** País (ISO) inicial; solo si no se pasa `storedValue`. */
  defaultCountry?: string | null;
  /** Número nacional inicial; solo si no se pasa `storedValue`. */
  defaultValue?: string | null;
  help?: string | null;
  testId?: string;
  onChange?: (v: PhoneFieldChange) => void;
};

/**
 * Campo de teléfono del CRM/POS con selector de país (bandera + prefijo) y número nacional.
 *
 * Mismo contrato que el del sitio (`apps/web/components/PhoneField.tsx`): manda `<name>_country` y
 * `<name>`, y quien decide el valor guardado es el servidor (`parsePhone` de `@pdp/domain`). Son dos
 * archivos porque cada app tiene su sistema visual —teal administrativo aquí, identidad de la
 * panadería allá— pero toda la lógica (catálogo, validación, normalización) es la misma y vive en
 * el dominio. Sin dependencias nuevas: banderas en emoji.
 */
export function PhoneField({
  name = "phone",
  label = "Teléfono",
  required,
  storedValue,
  defaultCountry,
  defaultValue,
  help,
  testId,
  onChange,
}: Props) {
  const uid = useId();
  const inputId = `${uid}-phone`;
  const helpId = `${uid}-phone-help`;
  const initial = storedValue
    ? splitStoredPhone(storedValue)
    : { country: phoneCountryOrDefault(defaultCountry), national: defaultValue ?? "" };
  const [country, setCountry] = useState<PhoneCountry>(initial.country);
  const [national, setNational] = useState(initial.national);
  const [open, setOpen] = useState(false);
  // Sin JavaScript el selector es un `<select>` nativo y el formulario se envía igual.
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
      <label className="label" htmlFor={inputId}>
        {label}
        {required ? " *" : ""}
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
                className="input flex min-h-11 items-center gap-1.5 tabular-nums"
                style={FIXED}
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  {country.flag}
                </span>
                <span>+{country.dial}</span>
                <span aria-hidden="true" className="text-[10px] text-muted">
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
              className="input min-h-11"
              style={NATIVE_SELECT}
            >
              {PHONE_COUNTRIES.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {c.flag} +{c.dial} {c.name}
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
            className="input min-h-11"
            style={GROW}
            required={required}
            maxLength={24}
            value={national}
            onChange={(e) => typed(e.target.value)}
            placeholder={enhanced ? country.example : undefined}
            aria-describedby={helpId}
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
            className="absolute top-[calc(100%+6px)] left-0 z-30 max-h-64 w-full max-w-sm overflow-y-auto rounded-card border border-line bg-card py-1 shadow-lift focus:outline-none"
          >
            {PHONE_COUNTRIES.map((c, i) => (
              <li key={c.iso}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.iso === country.iso}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(c)}
                  className={`flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm ${
                    i === active ? "bg-black/5" : ""
                  } ${c.iso === country.iso ? "font-semibold" : ""}`}
                >
                  <span aria-hidden="true" className="text-lg leading-none">
                    {c.flag}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-muted">+{c.dial}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Con la lista abierta la ayuda se atenúa (no se oculta: sigue siendo la descripción del input). */}
      <p id={helpId} className={`mt-1 text-xs text-muted ${open ? "opacity-0" : ""}`}>
        {help ? `${help} ` : ""}
        {enhanced ? `${phoneExample(country)}.` : NO_JS_HINT}
      </p>
    </div>
  );
}
