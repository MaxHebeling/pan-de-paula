"use client";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { blockedByStock, formatMXN, isOutOfStock, newIdempotencyKey } from "@pdp/domain";
import { postJson } from "@/components/pos/api";
import type { CatalogoAgregable, ProductoAgregable } from "@/lib/orderItems";

type Pendiente = { id: string; nombre: string; precio: number; qty: number };

type Resultado = {
  folio: string;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  duplicate: boolean;
  added: { product_name: string; qty: number }[];
};

/**
 * Agregar productos a un pedido que todavía no se cobró.
 *
 * El caso: la persona viene a retirar y en el mostrador pide dos conchas más. Antes había que
 * cobrarlas aparte y entregarle dos tickets.
 *
 * Se arma una lista y se confirma UNA vez, en lugar de mandar una petición por producto. No es
 * capricho: así el cajero puede corregir antes de tocar el pedido, y el envío lleva una sola clave
 * de idempotencia, de modo que un doble clic no agrega el pan dos veces.
 *
 * Qué NO hace, a propósito: no quita ni edita renglones. Quitar lo que el cliente ya pidió es otra
 * operación, con otras consecuencias (un pedido pagado a medias, un cupón que deja de alcanzar), y
 * mezclarla aquí convertiría un botón de mostrador en un editor de pedidos.
 */
export function AgregarProductos({
  orderId,
  catalogo,
  canal,
}: {
  orderId: string;
  catalogo: CatalogoAgregable;
  canal: string;
}) {
  const router = useRouter();
  const [busqueda, setBusqueda] = useState("");
  const [pendientes, setPendientes] = useState<Pendiente[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<Resultado | null>(null);
  // Una clave por tanda. Se renueva al confirmar: lo siguiente que agregue sí es otra operación.
  const [idem, setIdem] = useState(() => newIdempotencyKey("items"));

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

  const totalPendiente = pendientes.reduce((a, p) => a + p.precio * p.qty, 0);

  function sumar(p: ProductoAgregable) {
    if (bloqueado(p)) return;
    setHecho(null);
    setError(null);
    setPendientes((prev) => {
      const ya = prev.find((x) => x.id === p.id);
      if (ya) return prev.map((x) => (x.id === p.id ? { ...x, qty: x.qty + 1 } : x));
      return [...prev, { id: p.id, nombre: p.name, precio: p.priceCents ?? 0, qty: 1 }];
    });
    setBusqueda("");
  }

  function cambiarQty(id: string, delta: number) {
    setPendientes((prev) =>
      prev.flatMap((x) =>
        x.id === id ? (x.qty + delta <= 0 ? [] : [{ ...x, qty: x.qty + delta }]) : [x],
      ),
    );
  }

  async function confirmar() {
    if (pendientes.length === 0 || enviando) return;
    setEnviando(true);
    setError(null);
    const r = await postJson<Resultado>(`/api/pos/orders/${orderId}/items`, {
      idempotency_key: idem,
      items: pendientes.map((p) => ({ product_id: p.id, qty: p.qty })),
    }).catch((e: Error) => ({ ok: false as const, error: e.message, status: 0 }));

    setEnviando(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setHecho(r.data);
    setPendientes([]);
    setIdem(newIdempotencyKey("items"));
    // La página es `force-dynamic`: al refrescar, el total y el saldo por cobrar se recalculan en
    // el servidor. Aquí sí se refresca —a diferencia del cobro—, porque el pedido sigue siendo
    // cobrable y lo que el operador necesita ver es el saldo nuevo.
    router.refresh();
  }

  return (
    <div className="card mt-4 p-5 sm:p-6" data-testid="agregar-productos">
      <h2 className="font-display text-xl text-ink">Agregar productos</h2>
      <p className="mt-1 text-sm text-muted">
        Para lo que el cliente pida al llegar. Se cobra al precio{" "}
        {canal === "pos" ? "de mostrador" : "del pedido"} y se suma al saldo, en el mismo ticket.
      </p>

      <label className="label mt-4 block" htmlFor="agregar-buscar">
        Buscar producto para agregar
      </label>
      <input
        id="agregar-buscar"
        className="input min-h-11 w-full"
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        placeholder="Escribe el nombre del pan…"
        autoComplete="off"
        data-testid="agregar-buscar"
      />

      {coincidencias.length > 0 && (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {coincidencias.map((p) => {
            const sinStock = isOutOfStock({ trackStock: p.trackStock, onHand: p.onHand });
            const no = bloqueado(p);
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
                  disabled={no}
                  onClick={() => sumar(p)}
                  aria-label={`Agregar ${p.name}`}
                >
                  Agregar
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {pendientes.length > 0 && (
        <>
          <ul className="mt-4 divide-y divide-line" data-testid="agregar-pendientes">
            {pendientes.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{p.nombre}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm min-h-9"
                    onClick={() => cambiarQty(p.id, -1)}
                    aria-label={`Quitar uno de ${p.nombre}`}
                  >
                    −
                  </button>
                  <span className="w-8 text-center tabular-nums">{p.qty}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm min-h-9"
                    onClick={() => cambiarQty(p.id, 1)}
                    aria-label={`Sumar uno de ${p.nombre}`}
                  >
                    +
                  </button>
                </div>
                <span className="w-20 text-right text-sm tabular-nums">
                  {formatMXN(p.precio * p.qty)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              Se agregarán <strong>{formatMXN(totalPendiente)}</strong>
            </span>
            <button
              type="button"
              className="btn btn-confirm min-h-11"
              onClick={confirmar}
              disabled={enviando}
              data-testid="agregar-confirmar"
            >
              {enviando ? "Agregando…" : "Agregar al pedido"}
            </button>
          </div>
        </>
      )}

      {error && (
        <p className="card st-red mt-3 p-3 text-sm" role="alert" data-testid="agregar-error">
          {error}
        </p>
      )}
      {hecho && (
        <p className="card st-green mt-3 p-3 text-sm" role="status" data-testid="agregar-hecho">
          {hecho.duplicate
            ? "Esto ya se había agregado: no se duplicó."
            : `Se agregaron ${hecho.added.length} ${hecho.added.length === 1 ? "producto" : "productos"} a ${hecho.folio}.`}{" "}
          Saldo por cobrar: <strong>{formatMXN(hecho.balance_cents)}</strong>.
        </p>
      )}
    </div>
  );
}
