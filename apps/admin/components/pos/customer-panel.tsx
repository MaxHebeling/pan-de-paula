"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Cake, QrCode, UserPlus, X } from "lucide-react";
import { DEFAULT_PHONE_COUNTRY } from "@pdp/domain";
import { PhoneField } from "@/components/phone-field";
import { apiFetch, NetworkError, postJson } from "./api";
import { hasBarcodeDetector, QrScanner } from "./qr-scanner";
import type { PosCustomer } from "./types";

const noopSubscribe = () => () => {};

export function CustomerPanel({
  customer,
  onSelect,
  onClear,
  loyaltyEnabled,
}: {
  customer: PosCustomer | null;
  onSelect: (c: PosCustomer) => void;
  onClear: () => void;
  loyaltyEnabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PosCustomer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"search" | "new">("search");
  const [scanning, setScanning] = useState(false);
  const canScan = useSyncExternalStore(noopSubscribe, hasBarcodeDetector, () => false);
  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    phone_country: DEFAULT_PHONE_COUNTRY,
    email: "",
    birthday: "",
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(
    async (q: string) => {
      const term = q.trim();
      if (term.length < 2) return;
      setLoading(true);
      setError(null);
      try {
        const r = await apiFetch<{ customers: PosCustomer[] }>(
          `/api/pos/customers?q=${encodeURIComponent(term)}`,
        );
        if (!r.ok) {
          setError(r.error);
          return;
        }
        // Lectura exacta (QR / código / teléfono): selecciona directo.
        if (r.data.customers.length === 1 && term.length >= 8) {
          onSelect(r.data.customers[0]!);
          setQuery("");
          setResults(null);
          return;
        }
        setResults(r.data.customers);
      } catch (e) {
        setError(
          e instanceof NetworkError
            ? "Sin conexión: no se puede buscar clientes"
            : (e as Error).message,
        );
      } finally {
        setLoading(false);
      }
    },
    [onSelect],
  );

  const onDetected = useCallback(
    (value: string) => {
      setScanning(false);
      void search(value);
    },
    [search],
  );

  /*
   * Buscar mientras se escribe. Antes solo se buscaba al pulsar Enter, y ese paso invisible era la
   * trampa: quien tecleaba el código y seguía agregando productos se llevaba la venta SIN cliente,
   * aunque el código quedara escrito en el campo. Con esto, escribir el código basta.
   * 350 ms de espera para no consultar en cada tecla, y Enter sigue funcionando para quien lo use.
   */
  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) return;
    const t = setTimeout(() => void search(term), 350);
    return () => clearTimeout(t);
  }, [query, search]);

  async function register() {
    setLoading(true);
    setError(null);
    try {
      const r = await postJson<{ customer: PosCustomer | null; created: boolean }>(
        "/api/pos/customers",
        form,
      );
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.customer) {
        onSelect(r.data.customer);
        setForm({
          full_name: "",
          phone: "",
          phone_country: DEFAULT_PHONE_COUNTRY,
          email: "",
          birthday: "",
        });
        setMode("search");
      }
    } catch (e) {
      setError(
        e instanceof NetworkError
          ? "Sin conexión: no se puede dar de alta ahora"
          : (e as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }

  if (customer) {
    return (
      <div
        className="st-blue flex items-start justify-between gap-2 rounded-[var(--r-card)] px-3 py-2.5"
        data-testid="pos-customer"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">{customer.fullName}</span>
            {customer.birthdayToday && <Cake size={16} aria-label="Cumpleaños hoy" />}
          </div>
          <div className="text-xs opacity-80">
            {customer.publicCode}
            {customer.phone ? ` · ${customer.phone}` : ""}
          </div>
          {loyaltyEnabled && (
            <div className="mt-0.5 text-xs">
              <strong className="tabular-nums">{customer.pointsBalance}</strong> puntos
              {customer.tierName ? ` · nivel ${customer.tierName}` : ""} · {customer.totalOrders}{" "}
              compras
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="btn btn-secondary btn-sm min-h-11 min-w-11 bg-white/70"
          aria-label="Quitar cliente"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {mode === "search" ? (
        <>
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void search(query);
                }
              }}
              placeholder="Cliente: QR, código, teléfono, nombre…"
              aria-label="Buscar cliente"
              className="input min-h-11"
              autoComplete="off"
              enterKeyHint="search"
            />
            {canScan && (
              <button
                type="button"
                onClick={() => setScanning(true)}
                className="btn btn-secondary min-h-11 min-w-11 px-3"
                aria-label="Escanear QR con la cámara"
              >
                <QrCode size={18} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode("new")}
              className="btn btn-secondary min-h-11 min-w-11 px-3"
              aria-label="Alta rápida de cliente"
            >
              <UserPlus size={18} />
            </button>
          </div>
          {loading && <p className="text-xs text-muted">Buscando…</p>}
          {results && results.length === 0 && !loading && (
            <p className="text-xs text-muted">
              Sin resultados.{" "}
              <button
                type="button"
                className="font-semibold text-teal-d underline"
                onClick={() => setMode("new")}
              >
                Dar de alta
              </button>
            </p>
          )}
          {results && results.length > 0 && (
            <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-[var(--r-btn)] border border-line">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(c);
                      setResults(null);
                      setQuery("");
                    }}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-black/5"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{c.fullName}</span>
                      <span className="block text-xs text-muted">
                        {c.publicCode}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </span>
                    </span>
                    {loyaltyEnabled && (
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {c.pointsBalance} pts
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-2 rounded-[var(--r-card)] border border-line p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Alta rápida</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm min-h-9"
              onClick={() => setMode("search")}
            >
              Cancelar
            </button>
          </div>
          <input
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            placeholder="Nombre"
            aria-label="Nombre del cliente"
            className="input min-h-11"
            required
            minLength={2}
            autoFocus
          />
          <PhoneField
            name="pos_phone"
            label="Teléfono del cliente"
            required
            defaultCountry={form.phone_country}
            defaultValue={form.phone}
            testId="pos-phone"
            onChange={(v) => setForm({ ...form, phone: v.national, phone_country: v.country })}
          />
          {/* Correo y fecha de nacimiento son obligatorios en toda alta nueva (migración 0045): el
              correo abre su portal y de la fecha sale su cumpleaños. Si el cliente no los quiere dar,
              se cobra sin asignarle cuenta — la venta nunca se frena por esto. */}
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Correo (abre su portal)"
            aria-label="Correo del cliente"
            className="input min-h-11"
            type="email"
            inputMode="email"
            required
            autoComplete="off"
          />
          <label className="text-xs text-muted" htmlFor="pos-birthday">
            Fecha de nacimiento
          </label>
          <input
            id="pos-birthday"
            value={form.birthday}
            onChange={(e) => setForm({ ...form, birthday: e.target.value })}
            aria-label="Fecha de nacimiento del cliente"
            className="input min-h-11"
            type="date"
            required
            max={new Date().toISOString().slice(0, 10)}
            data-testid="pos-birthday"
          />
          <button className="btn btn-primary min-h-11" disabled={loading}>
            {loading ? "Guardando…" : "Registrar y usar"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="st-red rounded-[var(--r-btn)] px-3 py-2 text-xs">
          {error}
        </p>
      )}
      {scanning && <QrScanner onDetected={onDetected} onClose={() => setScanning(false)} />}
    </div>
  );
}
