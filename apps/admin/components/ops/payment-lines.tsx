import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@pdp/domain";
import { Money } from "@/components/ui";
import type { PaymentLine } from "@/lib/payments";

export const NO_REFERENCE = "—";

export const methodLabel = (m: string) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m;

/**
 * Pagos de una venta: método · monto · REFERENCIA CONTABLE, una línea por pago.
 *
 * En un pago dividido cada parte trae su propia referencia, así que nunca se colapsan en una sola línea.
 * Sin referencia se imprime "—" (no se inventa nada: los pagos anteriores a la captura de referencias
 * simplemente no la tienen). El identificador del proveedor (`externalId`, Mercado Pago) se muestra
 * etiquetado aparte para no confundirlo con la referencia contable.
 */
export function PaymentLines({
  payments,
  className = "",
}: {
  payments: PaymentLine[];
  className?: string;
}) {
  if (payments.length === 0)
    return <span className="text-sm text-muted">Sin pagos registrados.</span>;
  return (
    <ul className={`text-sm ${className}`} data-testid="payment-lines">
      {payments.map((p) => (
        <li key={p.id} className="flex flex-wrap justify-between gap-x-2 py-0.5">
          <span className="min-w-0">
            {methodLabel(p.method)}
            <span className="text-muted"> · ref. </span>
            <span className={p.reference ? "font-mono text-xs" : "text-muted"}>
              {p.reference ?? NO_REFERENCE}
            </span>
            {p.externalId && (
              <span className="text-xs text-muted"> · ID Mercado Pago {p.externalId}</span>
            )}
          </span>
          <Money cents={p.amountCents} />
        </li>
      ))}
    </ul>
  );
}

/** Misma información en una sola línea, para tablas apretadas (caja, historial del cliente). */
export function paymentsInline(payments: PaymentLine[]): string {
  if (payments.length === 0) return NO_REFERENCE;
  return payments
    .map((p) => `${methodLabel(p.method)} · ref. ${p.reference ?? NO_REFERENCE}`)
    .join(" + ");
}
