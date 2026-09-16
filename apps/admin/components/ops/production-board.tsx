"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Undo2, Check, Minus, Plus } from "lucide-react";
import {
  produceAction,
  reduceProductionAction,
  undoProductionAction,
  type ProduceResult,
} from "@/app/(app)/produccion/actions";

export type BoardProduct = {
  id: string;
  name: string;
  variant_label: string | null;
  unit_label: string;
  category_name: string;
  produced_today: number;
  on_hand: number;
  has_recipe: boolean;
};

// +1 vive en el stepper (− cantidad +); estos son los atajos de lote grande.
const QUICK = [5, 10, 20] as const;
const UNDO_SECONDS = 120;

type LastBatch = ProduceResult & { product_id: string; product_name: string; qty: number };

/** Tablero táctil de producción del día: un toque = un lote registrado. */
export function ProductionBoard({
  products,
  flagDefault,
  canWrite,
  threshold,
}: {
  products: BoardProduct[];
  flagDefault: boolean;
  canWrite: boolean;
  threshold: number;
}) {
  const [totals, setTotals] = useState<Record<string, { produced_today: number; on_hand: number }>>(
    () =>
      Object.fromEntries(
        products.map((p) => [p.id, { produced_today: p.produced_today, on_hand: p.on_hand }]),
      ),
  );
  const [consume, setConsume] = useState(flagDefault);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<LastBatch | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [, startTransition] = useTransition();
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!last) return;
    const startedAt = new Date(last.created_at).getTime();
    const tick = () => {
      const left = Math.max(0, UNDO_SECONDS - Math.floor((Date.now() - startedAt) / 1000));
      setRemaining(left);
      if (left === 0) setLast(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [last]);

  const showFlash = (productId: string, text: string) => {
    setFlash((f) => ({ ...f, [productId]: text }));
    clearTimeout(flashTimers.current[productId]);
    flashTimers.current[productId] = setTimeout(() => {
      setFlash((f) => {
        const next = { ...f };
        delete next[productId];
        return next;
      });
    }, 1600);
  };

  const produce = (p: BoardProduct, qty: number) => {
    if (!canWrite || busy || !(qty > 0)) return;
    setBusy(p.id);
    setError(null);
    startTransition(async () => {
      const r = await produceAction({ product_id: p.id, qty, consume_ingredients: consume });
      setBusy(null);
      if (!r.ok) {
        setError(`${p.name}: ${r.error}`);
        return;
      }
      setTotals((t) => ({
        ...t,
        [p.id]: { produced_today: r.data.produced_today, on_hand: r.data.on_hand },
      }));
      setManual((m) => ({ ...m, [p.id]: "" }));
      setLast({ ...r.data, product_id: p.id, product_name: p.name, qty });
      showFlash(p.id, `+${qty} · ${r.data.lot_code}`);
    });
  };

  /** Operación inversa: resta del día. El tope real lo valida SQL; aquí solo se evita el envío obvio. */
  const reduce = (p: BoardProduct, qty: number) => {
    if (!canWrite || busy || !(qty > 0)) return;
    setBusy(p.id);
    setError(null);
    startTransition(async () => {
      const r = await reduceProductionAction({ product_id: p.id, qty });
      setBusy(null);
      if (!r.ok) {
        setError(`${p.name}: ${r.error}`);
        return;
      }
      setTotals((t) => ({
        ...t,
        [p.id]: { produced_today: r.data.produced_today, on_hand: r.data.on_hand },
      }));
      setManual((m) => ({ ...m, [p.id]: "" }));
      // El banner "Deshacer" apunta a un lote que la resta pudo consumir: se retira para no mentir.
      setLast(null);
      showFlash(p.id, `−${qty}`);
    });
  };

  const undo = () => {
    if (!last || busy) return;
    const target = last;
    setBusy(target.product_id);
    setError(null);
    startTransition(async () => {
      const r = await undoProductionAction({ batch_id: target.batch_id });
      setBusy(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTotals((t) => ({ ...t, [target.product_id]: r.data }));
      setLast(null);
      showFlash(target.product_id, `−${target.qty} deshecho`);
    });
  };

  const groups = new Map<string, BoardProduct[]>();
  for (const p of products) {
    const list = groups.get(p.category_name) ?? [];
    list.push(p);
    groups.set(p.category_name, list);
  }
  const totalToday = Object.values(totals).reduce((a, t) => a + t.produced_today, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="text-sm">
          <span className="font-semibold">Producido hoy:</span>{" "}
          <span className="tabular-nums" data-testid="total-today">
            {totalToday.toLocaleString("es-MX")}
          </span>{" "}
          piezas
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5 accent-[var(--teal)]"
            checked={consume}
            onChange={(e) => setConsume(e.target.checked)}
            disabled={!canWrite}
          />
          Descontar ingredientes
          <span className="text-xs text-muted">
            ({flagDefault ? "activo" : "apagado"} por configuración)
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="st-red rounded-[var(--r-card)] px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {last && (
        <div
          className="st-amber flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-sm"
          role="status"
        >
          <span>
            Último lote: <strong>{last.product_name}</strong> +{last.qty} · {last.lot_code}
            {last.ingredients_consumed ? " · insumos descontados" : ""}
          </span>
          <button
            type="button"
            className="btn btn-undo min-h-11"
            onClick={undo}
            disabled={busy !== null}
            data-testid="undo-last"
          >
            <Undo2 size={16} aria-hidden /> Deshacer ({remaining}s)
          </button>
        </div>
      )}

      {[...groups.entries()].map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
            {category}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((p) => {
              const t = totals[p.id] ?? { produced_today: 0, on_hand: 0 };
              const low = t.on_hand <= threshold;
              const isBusy = busy === p.id;
              const manualQty = Number(manual[p.id] ?? "");
              const canManualAdd = canWrite && busy === null && manualQty > 0;
              const canManualSub = canManualAdd && manualQty <= t.produced_today;
              return (
                <article
                  key={p.id}
                  className={`card relative flex flex-col gap-3 p-4 transition ${isBusy ? "opacity-70" : ""}`}
                  data-testid={`product-card-${p.id}`}
                  data-product-name={p.name}
                >
                  {flash[p.id] && (
                    <div className="st-green pill absolute right-3 top-3 flex items-center gap-1 px-2.5 py-1 text-xs font-semibold">
                      <Check size={14} aria-hidden /> {flash[p.id]}
                    </div>
                  )}
                  <div>
                    <h3 className="pr-24 text-base font-semibold leading-tight">
                      {p.name}
                      {p.variant_label && <span className="text-muted"> · {p.variant_label}</span>}
                    </h3>
                    <p className="mt-1 text-sm text-muted">
                      Stock:{" "}
                      <span
                        className={`font-semibold tabular-nums ${low ? "text-amber-d" : "text-ink"}`}
                        data-testid="on-hand"
                      >
                        {t.on_hand.toLocaleString("es-MX")}
                      </span>
                      {consume && !p.has_recipe && (
                        <span className="ml-1 text-xs">(sin receta)</span>
                      )}
                    </p>
                  </div>
                  {/* Stepper: − producido hoy + (la cantidad es la del servidor, nunca un optimismo local) */}
                  <div
                    className="flex items-center gap-2"
                    role="group"
                    aria-label={`Producción de hoy de ${p.name}`}
                  >
                    <button
                      type="button"
                      className="btn btn-danger min-h-14 w-14 shrink-0 text-lg"
                      onClick={() => reduce(p, 1)}
                      disabled={!canWrite || busy !== null || t.produced_today < 1}
                      aria-label={`Restar 1 de ${p.name}`}
                      data-testid="step-minus"
                    >
                      <Minus size={22} aria-hidden />
                    </button>
                    <div className="flex-1 text-center leading-tight">
                      <span
                        className="block text-2xl font-semibold tabular-nums text-ink"
                        data-testid="produced-today"
                      >
                        {t.produced_today.toLocaleString("es-MX")}
                      </span>
                      <span className="text-xs text-muted">producido hoy</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary min-h-14 w-14 shrink-0 text-lg"
                      onClick={() => produce(p, 1)}
                      disabled={!canWrite || busy !== null}
                      aria-label={`Registrar 1 de ${p.name}`}
                      data-testid="step-plus"
                    >
                      <Plus size={22} aria-hidden />
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {QUICK.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className="btn btn-primary min-h-14 text-lg"
                        onClick={() => produce(p, q)}
                        disabled={!canWrite || busy !== null}
                        aria-label={`Registrar ${q} de ${p.name}`}
                      >
                        +{q}
                      </button>
                    ))}
                  </div>
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      produce(p, Number(manual[p.id] ?? ""));
                    }}
                  >
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={9999}
                      step={1}
                      placeholder="Otra cantidad"
                      className="input min-h-12 w-full sm:w-auto sm:flex-1"
                      value={manual[p.id] ?? ""}
                      onChange={(e) => setManual((m) => ({ ...m, [p.id]: e.target.value }))}
                      disabled={!canWrite}
                      aria-label={`Cantidad manual de ${p.name}`}
                      data-testid="manual-qty"
                    />
                    <button
                      type="submit"
                      className="btn btn-secondary min-h-12 flex-1 px-4 sm:flex-none"
                      disabled={!canManualAdd}
                      aria-label={`Registrar la cantidad escrita de ${p.name}`}
                      data-testid="manual-add"
                    >
                      Registrar
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger min-h-12 flex-1 px-4 sm:flex-none"
                      onClick={() => reduce(p, manualQty)}
                      disabled={!canManualSub}
                      aria-label={`Restar la cantidad escrita de ${p.name}`}
                      title={
                        canManualAdd && !canManualSub
                          ? "No puedes restar más de lo producido hoy"
                          : undefined
                      }
                      data-testid="manual-sub"
                    >
                      Restar
                    </button>
                  </form>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
