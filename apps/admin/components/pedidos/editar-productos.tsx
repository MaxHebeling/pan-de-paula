"use client";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { blockedByStock, formatMXN, isOutOfStock, newIdempotencyKey } from "@pdp/domain";
import { apiFetch } from "@/components/pos/api";
import type { CatalogoAgregable, ProductoAgregable } from "@/lib/orderItems";

/** Renglón tal como está hoy en el pedido. */
export type RenglonPedido = {
  id: string;
  productId: string | null;
  name: string;
  variantLabel: string | null;
  qty: number;
  unitPriceCents: number;
  discountCents: number;
};

/*
 * Borrador de la lista FINAL. `orderItemId` = renglón que ya estaba (conserva su precio pactado);
 * sin él = producto nuevo al precio vigente del canal del pedido.
 */
type Borrador = {
  key: string;
  orderItemId?: string;
  productId: string | null;
  name: string;
  unitPriceCents: number;
  qty: number;
  originalQty?: number;
  discountCents: number;
};

type Resultado = {
  folio: string;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_status: string;
  sale_id: string | null;
  duplicate: boolean;
};

const desdePedido = (items: RenglonPedido[]): Borrador[] =>
  items.map((it) => ({
    key: it.id,
    orderItemId: it.id,
    productId: it.productId,
    name: it.variantLabel ? `${it.name} · ${it.variantLabel}` : it.name,
    unitPriceCents: it.unitPriceCents,
    qty: it.qty,
    originalQty: it.qty,
    discountCents: it.discountCents,
  }));

// Mismo cálculo que `edit_order_items`: el descuento de renglón se ajusta en proporción a la cantidad.
const totalRenglon = (b: Borrador) => {
  const disc =
    b.originalQty && b.originalQty > 0 ? Math.round((b.discountCents * b.qty) / b.originalQty) : 0;
  return Math.max(Math.round(b.unitPriceCents * b.qty) - disc, 0);
};

/**
 * Editar los productos de un pedido sin cobrar: cambiar cantidades, quitar, agregar o cambiar un
 * producto por otro (quitar uno y agregar el otro).
 *
 * Solo se monta para quien tiene `orders.edit_items` (administración y gerencia). Se arma la lista
 * final completa y se guarda UNA vez con una sola clave de idempotencia: el administrador puede
 * corregir antes de tocar el pedido y un doble clic no edita dos veces.
 *
 * El total exacto lo calcula la base (`edit_order_items`, migración 0085): el descuento del cupón
 * puede bajar con el pedido pero nunca sube, y el total no puede quedar por debajo de lo pagado.
 */
export function EditarProductos({
  orderId,
  canal,
  items,
  subtotalCents,
  discountCents,
  paidCents,
  catalogo,
}: {
  orderId: string;
  canal: string;
  items: RenglonPedido[];
  subtotalCents: number;
  discountCents: number;
  paidCents: number;
  catalogo: CatalogoAgregable;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [borrador, setBorrador] = useState<Borrador[]>(() => desdePedido(items));
  const [busqueda, setBusqueda] = useState("");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<Resultado | null>(null);
  const [idem, setIdem] = useState(() => newIdempotencyKey("edit"));

  const bloqueado = useCallback(
    (p: ProductoAgregable) =>
      p.priceCents === null ||
      (!catalogo.allowNegativeStock &&
        blockedByStock({
          trackStock: p.trackStock,
          onHand: p.onHand,
          allowPreorder: p.allowPreorder,
        })),
    [catalogo.allowNegativeStock],
  );

  const coincidencias = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return [];
    return catalogo.productos.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [busqueda, catalogo.productos]);

  const subtotalNuevo = borrador.reduce((a, b) => a + totalRenglon(b), 0);
  const quitados = items.filter((it) => !borrador.some((b) => b.orderItemId === it.id));
  const hayCambios =
    quitados.length > 0 || borrador.some((b) => !b.orderItemId || b.qty !== b.originalQty);

  function reiniciar() {
    setBorrador(desdePedido(items));
    setBusqueda("");
    setMotivo("");
    setError(null);
  }

  function cambiarQty(key: string, delta: number) {
    setHecho(null);
    setBorrador((prev) =>
      prev.map((b) => (b.key === key && b.qty + delta > 0 ? { ...b, qty: b.qty + delta } : b)),
    );
  }

  function quitar(key: string) {
    setHecho(null);
    setBorrador((prev) => prev.filter((b) => b.key !== key));
  }

  function agregar(p: ProductoAgregable) {
    if (bloqueado(p)) return;
    setHecho(null);
    setError(null);
    setBorrador((prev) => {
      // Si ya hay un renglón NUEVO de ese producto se suma ahí; uno que ya estaba conserva su precio.
      const ya = prev.find((b) => !b.orderItemId && b.productId === p.id);
      if (ya) return prev.map((b) => (b === ya ? { ...b, qty: b.qty + 1 } : b));
      return [
        ...prev,
        {
          key: `nuevo-${p.id}`,
          productId: p.id,
          name: p.variantLabel ? `${p.name} · ${p.variantLabel}` : p.name,
          unitPriceCents: p.priceCents ?? 0,
          qty: 1,
          discountCents: 0,
        },
      ];
    });
    setBusqueda("");
  }

  async function guardar() {
    if (!hayCambios || enviando) return;
    if (borrador.length === 0) {
      setError("El pedido necesita al menos un producto. Para quitarlos todos, cancela el pedido.");
      return;
    }
    const aviso =
      `¿Guardar los cambios? El subtotal pasa de ${formatMXN(subtotalCents)} a ${formatMXN(subtotalNuevo)}.` +
      (quitados.length ? ` Se quitan: ${quitados.map((q) => q.name).join(", ")}.` : "");
    if (!window.confirm(aviso)) return;

    setEnviando(true);
    setError(null);
    const r = await apiFetch<Resultado>(`/api/pos/orders/${orderId}/items`, {
      method: "PUT",
      body: JSON.stringify({
        idempotency_key: idem,
        reason: motivo.trim() || undefined,
        items: borrador.map((b) =>
          b.orderItemId
            ? { order_item_id: b.orderItemId, qty: b.qty }
            : { product_id: b.productId, qty: b.qty },
        ),
      }),
    }).catch((e: Error) => ({ ok: false as const, error: e.message, status: 0 }));
    setEnviando(false);

    if (!r.ok) {
      setError(r.error);
      return;
    }
    setHecho(r.data);
    setIdem(newIdempotencyKey("edit"));
    setMotivo("");
    setAbierto(false);
    router.refresh();
  }

  if (!abierto) {
    return (
      <div className="card mt-4 p-5 sm:p-6" data-testid="editar-productos">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-xl text-ink">Editar productos</h2>
            <p className="mt-1 text-sm text-muted">
              Cambiar cantidades, quitar o cambiar productos mientras el pedido no esté cobrado.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            onClick={() => {
              reiniciar();
              setAbierto(true);
            }}
            data-testid="editar-abrir"
          >
            Editar pedido
          </button>
        </div>
        {hecho && (
          <p className="card st-green mt-3 p-3 text-sm" role="status" data-testid="editar-hecho">
            {hecho.duplicate
              ? "Ese cambio ya se había guardado: no se repitió."
              : `Pedido ${hecho.folio} actualizado.`}{" "}
            Total: <strong>{formatMXN(hecho.total_cents)}</strong>
            {hecho.sale_id
              ? " · el anticipo cubre el pedido: quedó pagado."
              : ` · por cobrar: ${formatMXN(hecho.balance_cents)}.`}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card mt-4 p-5 sm:p-6" data-testid="editar-productos">
      <h2 className="font-display text-xl text-ink">Editar productos</h2>
      <p className="mt-1 text-sm text-muted">
        Lo que ya estaba conserva su precio. Lo nuevo se cobra al precio{" "}
        {canal === "pos" ? "de mostrador" : "del pedido"}.
        {discountCents > 0 && " El descuento puede bajar con el pedido, pero nunca sube."}
      </p>

      <ul className="mt-4 divide-y divide-line" data-testid="editar-renglones">
        {borrador.map((b) => (
          <li key={b.key} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {b.name}
                {!b.orderItemId && <span className="ml-1 text-xs text-teal-d">· nuevo</span>}
              </div>
              <div className="text-xs text-muted">{formatMXN(b.unitPriceCents)} c/u</div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-secondary btn-sm min-h-9"
                onClick={() => cambiarQty(b.key, -1)}
                disabled={b.qty - 1 <= 0}
                aria-label={`Restar uno de ${b.name}`}
              >
                −
              </button>
              <span className="w-10 text-center tabular-nums">{b.qty}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm min-h-9"
                onClick={() => cambiarQty(b.key, 1)}
                aria-label={`Sumar uno de ${b.name}`}
              >
                +
              </button>
            </div>
            <span className="w-20 text-right text-sm tabular-nums">
              {formatMXN(totalRenglon(b))}
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm min-h-9"
              onClick={() => quitar(b.key)}
              aria-label={`Quitar ${b.name}`}
            >
              Quitar
            </button>
          </li>
        ))}
      </ul>

      {quitados.length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid="editar-quitados">
          Se quitan: {quitados.map((q) => q.name).join(", ")}
        </p>
      )}

      <label className="label mt-4 block" htmlFor="editar-buscar">
        Agregar o cambiar por otro producto
      </label>
      <input
        id="editar-buscar"
        className="input min-h-11 w-full"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Escribe el nombre del pan…"
        autoComplete="off"
        data-testid="editar-buscar"
      />
      {coincidencias.length > 0 && (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {coincidencias.map((p) => {
            const sinStock = isOutOfStock({ trackStock: p.trackStock, onHand: p.onHand });
            return (
              <li key={p.id} className="flex items-center justify-between gap-2 p-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {p.name}
                    {p.variantLabel && <span className="text-muted"> · {p.variantLabel}</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {p.priceCents === null
                      ? "Sin precio para este pedido"
                      : formatMXN(p.priceCents)}
                    {sinStock && !p.allowPreorder && " · Agotado"}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm min-h-9"
                  disabled={bloqueado(p)}
                  onClick={() => agregar(p)}
                  aria-label={`Agregar ${p.name}`}
                >
                  Agregar
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <label className="label mt-4 block" htmlFor="editar-motivo">
        Motivo del cambio (opcional)
      </label>
      <input
        id="editar-motivo"
        className="input min-h-11 w-full"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        maxLength={300}
        placeholder="Ej. el cliente llamó para cambiar las donas por conchas"
        data-testid="editar-motivo"
      />

      <dl className="mt-4 grid max-w-xs grid-cols-2 gap-y-1 text-sm sm:ml-auto">
        <dt className="text-muted">Subtotal actual</dt>
        <dd className="text-right tabular-nums">{formatMXN(subtotalCents)}</dd>
        <dt className="font-semibold">Subtotal nuevo</dt>
        <dd className="text-right font-semibold tabular-nums" data-testid="editar-subtotal">
          {formatMXN(subtotalNuevo)}
        </dd>
      </dl>
      {paidCents > 0 && (
        <p className="mt-2 text-xs text-muted">
          Ya se pagaron {formatMXN(paidCents)}: el total nuevo no puede quedar por debajo. Si hace
          falta, registra primero el reembolso del excedente.
        </p>
      )}

      {error && (
        <p className="card st-red mt-3 p-3 text-sm" role="alert" data-testid="editar-error">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn btn-secondary min-h-11"
          onClick={() => {
            reiniciar();
            setAbierto(false);
          }}
          disabled={enviando}
        >
          Descartar
        </button>
        <button
          type="button"
          className="btn btn-confirm min-h-11"
          onClick={guardar}
          disabled={!hayCambios || enviando || borrador.length === 0}
          data-testid="editar-guardar"
        >
          {enviando ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}
