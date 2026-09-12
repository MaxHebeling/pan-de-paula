"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

type Results = {
  q: string;
  customers: Array<{ id: string; public_code: string; full_name: string; phone: string | null; points_balance: number }>;
  orders: Array<{ id: string; folio: string; channel: string; status: string; total_cents: number; customer_name: string | null }>;
  products: Array<{ id: string; name: string; category_name: string | null; price_cents: number | null; on_hand: string | null }>;
};
type Item = { key: string; href: string; title: string; sub: string; group: string };

const mxn = (c: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(c / 100);

function toItems(r: Results): Item[] {
  return [
    ...r.customers.map((c) => ({ key: `c-${c.id}`, href: `/clientes/${c.id}`, title: c.full_name, sub: `${c.public_code}${c.phone ? ` · ${c.phone}` : ""} · ${c.points_balance} pts`, group: "Clientes" })),
    ...r.orders.map((o) => ({ key: `o-${o.id}`, href: `/pedidos?q=${encodeURIComponent(o.folio)}`, title: o.folio, sub: `${o.customer_name ?? "sin nombre"} · ${mxn(o.total_cents)} · ${o.status}`, group: "Pedidos" })),
    ...r.products.map((p) => ({ key: `p-${p.id}`, href: `/productos?q=${encodeURIComponent(p.name)}`, title: p.name, sub: `${p.category_name ?? ""}${p.price_cents !== null ? ` · ${mxn(p.price_cents)}` : ""}${p.on_hand !== null ? ` · stock ${Number(p.on_hand)}` : ""}`, group: "Productos" })),
  ];
}

/** Búsqueda global (⌘K / Ctrl+K): clientes, pedidos y productos vía GET /api/search. */
export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setItems([]);
    setError(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as Results;
        setItems(toItems(data));
        setActive(0);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("No se pudo buscar. Intenta de nuevo.");
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const go = useCallback(
    (href: string) => {
      close();
      router.push(href);
    },
    [router, close],
  );
  const visible = q.trim().length >= 2 ? items : [];
  const rows = visible.map((it, i) => ({ ...it, showGroup: i === 0 || visible[i - 1]!.group !== it.group }));

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(visible.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = visible[active];
      if (it) go(it.href);
      else if (q.trim().length >= 2) go(`/buscar?q=${encodeURIComponent(q.trim())}`);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-label="Buscar (⌘K)" title="Buscar clientes, pedidos y productos (⌘K)" onClick={() => setOpen(true)}>
        <Search size={18} />
        <span className="hidden text-xs text-muted lg:inline">⌘K</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-3 pt-[10vh]" onClick={close}>
          <div role="dialog" aria-modal="true" aria-label="Búsqueda global" className="card card-lg w-full max-w-xl overflow-hidden shadow-lift" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search size={18} className="text-muted" aria-hidden />
              <input
                ref={inputRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Cliente, teléfono, código PDP, folio o producto…"
                className="w-full bg-transparent py-3 text-base outline-none"
                role="combobox"
                aria-expanded={visible.length > 0}
                aria-controls={listId}
                aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
                autoComplete="off"
              />
              <button type="button" className="btn btn-secondary btn-sm" aria-label="Cerrar" onClick={close}>
                <X size={16} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {error && <p className="px-4 py-3 text-sm text-red-d">{error}</p>}
              {!error && q.trim().length < 2 && <p className="px-4 py-3 text-sm text-muted">Escribe al menos 2 caracteres. Enter abre la página de resultados.</p>}
              {!error && q.trim().length >= 2 && !loading && visible.length === 0 && <p className="px-4 py-3 text-sm text-muted">Sin resultados para “{q.trim()}”.</p>}
              <ul id={listId} role="listbox">
                {rows.map((it, i) => {
                  return (
                    <li key={it.key} role="presentation">
                      {it.showGroup && <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{it.group}</div>}
                      <button
                        type="button"
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-teal/10" : "hover:bg-black/[0.03]"}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(it.href)}
                      >
                        <span className="font-medium">{it.title}</span>
                        <span className="truncate text-xs text-muted">{it.sub}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {q.trim().length >= 2 && (
                <button type="button" className="block w-full border-t border-line px-4 py-2 text-left text-sm text-teal-d hover:bg-black/[0.03]" onClick={() => go(`/buscar?q=${encodeURIComponent(q.trim())}`)}>
                  Ver todos los resultados de “{q.trim()}”
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
