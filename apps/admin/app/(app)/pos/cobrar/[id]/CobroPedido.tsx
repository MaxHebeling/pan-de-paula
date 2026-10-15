"use client";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { formatMXN, newIdempotencyKey } from "@pdp/domain";
import { postJson, apiFetch } from "@/components/pos/api";
import { CheckoutModal } from "@/components/pos/checkout-modal";
import type { MpHandlers } from "@/components/pos/mp-payment";
import type { CheckoutPayment, PosConfig, PaymentStatusResult } from "@/components/pos/types";

type CobroResultado = {
  orderId: string;
  saleId: string | null;
  folio: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  changeCents: number;
  paymentStatus: string;
  duplicate: boolean;
};

/**
 * Cobro de un pedido guardado, con el MISMO panel de pagos de la venta directa.
 *
 * `CheckoutModal` ya venía desacoplado de `pos_checkout`: recibe `totalCents` y un `onSubmit`, y el
 * padre decide qué hacer al confirmar. Así que aquí se reutiliza tal cual —efectivo con vuelto,
 * tarjeta, transferencia, Mercado Pago Point, QR y pago dividido— y su `onSubmit` apunta a
 * `/api/pos/orders/[id]/pay`, que registra con `record_payment` sobre el pedido que YA existe. No
 * hay un segundo motor de cobros ni una segunda pantalla de pagos.
 *
 * Se abre solo. Enviar el pedido desde el CRM ya fue la decisión del operador; obligarlo a pulsar
 * otro botón para llegar a los medios de pago era el paso de más que sobraba.
 *
 * El importe es el SALDO, no el total: con un anticipo aplicado, cobrar el total le sacaría al
 * cliente dinero que ya pagó.
 */
export function CobroPedido({
  orderId,
  folio,
  balanceCents,
  config,
  volverA,
}: {
  orderId: string;
  folio: string;
  balanceCents: number;
  config: PosConfig;
  volverA: string;
}) {
  const [abierto, setAbierto] = useState(true);
  const [resultado, setResultado] = useState<CobroResultado | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Una clave por intento. Un doble clic manda la MISMA y `record_payment` devuelve el pago ya
  // registrado; tras un cobro con Mercado Pago abandonado se renueva, porque entonces sí es otro.
  const [idem, setIdem] = useState(() => newIdempotencyKey("cobro"));

  const onSubmit = useCallback(
    async (payments: CheckoutPayment[]) => {
      if (payments.length === 0) return { ok: false as const, error: "Elige un medio de pago" };
      const r = await postJson<CobroResultado>(`/api/pos/orders/${orderId}/pay`, {
        idempotency_key: idem,
        payments,
      });
      if (!r.ok) return { ok: false as const, error: r.error };
      setResultado(r.data);
      setAbierto(false);
      /*
       * Aquí NO se refresca el componente de servidor. Al cobrarse, el pedido deja de ser
       * "cobrable" y la página dejaría de montar este componente: el operador vería desaparecer el
       * resultado —y el cambio a entregar— justo después de cobrar. El detalle del pedido es
       * `force-dynamic`, así que al pulsar "Volver al pedido" ya llega actualizado.
       */
      return { ok: true as const };
    },
    [orderId, idem],
  );

  /**
   * Mercado Pago sobre un pedido existente: `existing_order_id` evita que la ruta cree otro pedido,
   * y el importe que viaja al proveedor es el saldo. La confirmación la da el webhook, no el
   * cliente: aquí solo se arranca y se consulta el estado.
   */
  const mp = useMemo<MpHandlers>(
    () => ({
      start: (kind) =>
        postJson("/api/pos/payments/mercadopago", {
          idempotency_key: idem,
          existing_order_id: orderId,
          kind,
        }),
      status: (id) => apiFetch<PaymentStatusResult>(`/api/pos/payments/status?orderId=${id}`),
      cancel: (id) => postJson("/api/pos/payments/mercadopago/cancel", { orderId: id }),
      onConfirmed: (s: PaymentStatusResult) => {
        setResultado({
          orderId: s.orderId,
          saleId: s.saleId,
          folio: s.folio,
          totalCents: s.totalCents,
          paidCents: s.paidCents,
          balanceCents: Math.max(0, s.totalCents - s.paidCents),
          changeCents: 0,
          paymentStatus: s.status,
          duplicate: false,
        });
        setAbierto(false);
      },
      onAbandoned: () => {
        setIdem(newIdempotencyKey("cobro"));
        setAbierto(false);
        setAviso("Cobro con Mercado Pago cancelado. Puedes cobrar con otro método.");
      },
    }),
    [orderId, idem],
  );

  if (resultado) {
    const liquidado = resultado.balanceCents <= 0;
    return (
      <div className="card p-5 sm:p-6" data-testid="cobro-resultado">
        <h2 className="font-display text-xl text-ink">
          {liquidado ? `${resultado.folio} pagado` : `${resultado.folio} · pago parcial`}
        </h2>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Total del pedido</dt>
            <dd>{formatMXN(resultado.totalCents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Pagado</dt>
            <dd>{formatMXN(resultado.paidCents)}</dd>
          </div>
          {resultado.changeCents > 0 && (
            <div className="flex justify-between font-semibold">
              <dt>Cambio</dt>
              <dd data-testid="cobro-cambio">{formatMXN(resultado.changeCents)}</dd>
            </div>
          )}
          {!liquidado && (
            <div className="flex justify-between border-t border-line pt-1.5 font-semibold">
              <dt>Saldo que queda</dt>
              <dd data-testid="cobro-saldo-restante">{formatMXN(resultado.balanceCents)}</dd>
            </div>
          )}
        </dl>
        {resultado.duplicate && (
          <p className="mt-2 text-sm text-muted">
            Este cobro ya estaba registrado: no se cobró dos veces.
          </p>
        )}
        <p className="mt-3 text-sm text-muted">
          Cobrar no entrega el pedido. El estado de entrega se cambia aparte, desde el pedido.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={volverA} className="btn btn-primary min-h-11">
            Volver al pedido
          </Link>
          {!liquidado && (
            <button
              type="button"
              className="btn btn-secondary min-h-11"
              onClick={() => {
                setIdem(newIdempotencyKey("cobro"));
                setResultado(null);
                setAbierto(true);
              }}
            >
              Cobrar el resto
            </button>
          )}
          <Link href="/pos/pendientes" className="btn btn-secondary min-h-11">
            Pendientes de cobro
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {aviso && (
        <p className="card st-amber p-4 text-sm" role="status" data-testid="cobro-aviso">
          {aviso}
        </p>
      )}
      {!abierto && (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Saldo por cobrar de {folio}: <strong>{formatMXN(balanceCents)}</strong>
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-confirm min-h-11"
              onClick={() => {
                setAviso(null);
                setAbierto(true);
              }}
              data-testid="cobro-reabrir"
            >
              Elegir medio de pago
            </button>
            <Link href={volverA} className="btn btn-secondary min-h-11">
              Volver al pedido
            </Link>
          </div>
        </div>
      )}
      <CheckoutModal
        open={abierto}
        totalCents={balanceCents}
        config={config}
        onClose={() => setAbierto(false)}
        onSubmit={onSubmit}
        mp={mp}
      />
    </>
  );
}
